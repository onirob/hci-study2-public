import React, { useMemo, useRef, useState, useEffect  } from 'react';
import {
  Grid, Card, CardContent, Typography, Box, ToggleButton, ToggleButtonGroup,
  Button, Popover, Stack, Divider, Chip,
} from '@mui/material';
import { useTheme, alpha } from '@mui/material/styles';
import CalendarMonthIcon from '@mui/icons-material/CalendarMonth';

import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterDateFns } from '@mui/x-date-pickers/AdapterDateFns';
import { DateCalendar } from '@mui/x-date-pickers/DateCalendar';
import { PickersDay } from '@mui/x-date-pickers/PickersDay';
import type { PickersDayProps } from '@mui/x-date-pickers/PickersDay';
import {
  format, isAfter, isSameDay, isWithinInterval,
  startOfDay, endOfDay, startOfWeek, endOfWeek,
  startOfMonth, endOfMonth, subDays
} from 'date-fns';
import { utcToZonedTime, zonedTimeToUtc, formatInTimeZone } from 'date-fns-tz';

import { useParams, useLocation } from 'react-router-dom';

// updated hook (new API)
import { useDashboardData, parseBucketToMinutes, pickAdaptiveBucket } from '../hooks/useDashboardData';

// components (we'll adapt these in the next step)
import MachineTable from '../components/Dashboard/MachineTable';
import TrendChart from '../components/Dashboard/TrendChart';
import { MachineUtilizationRow } from '../components/Dashboard/MachineUtilizationRow';
import OeeSummaryTile from '../components/Dashboard/OeeSummaryTile';
import CyclesTile from '../components/Dashboard/CyclesTile';
import MachineOverlayPanel from '../components/Dashboard/MachineOverlayPanel';



type ViewKey = 'status' | 'consumption' | 'productivity';

type Props = {
  demo?: boolean;
  /** Used only by the familiarization tour to show a specific area while keeping UI frozen. */
  forceView?: ViewKey;
};

export default function Dashboard({ demo = false, forceView }: Props) {
  const { taskId } = useParams();
  const theme = useTheme();

  const isPreview = demo || typeof forceView !== 'undefined';
  const [view, setView] = useState<ViewKey>('status');
  const effectiveView = forceView ?? view;

  const topAnchorRef = useRef<HTMLDivElement | null>(null);

  // smooth scroll helper
  const scrollToTopOfDashboard = () => {
    const el = topAnchorRef.current;
    if (!el) return;

    // native (uses nearest scrollable ancestor)
    el.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'nearest' });

    // fallback for cases where sticky is considered “in view”
    const y = window.scrollY + el.getBoundingClientRect().top - 4;
    window.scrollTo({ top: y, behavior: 'smooth' });
  };

  const handleViewChange = (_: React.MouseEvent<HTMLElement>, next: ViewKey | null) => {
    if (overlayOpen) return;
    if (next) setView(next);
    requestAnimationFrame(scrollToTopOfDashboard);
  };

  const didMountRef = useRef(false);
  useEffect(() => {
    if (didMountRef.current) scrollToTopOfDashboard();
    else didMountRef.current = true;
  }, [effectiveView]);

  // ---------------- Fixed study config (hidden) ----------------
  const SCENARIO_TZ = 'Europe/Rome';
  // 11:30 "scenario now" in Rome == 10:30Z
  const SCENARIO_ANCHOR_UTC = '2025-11-05T10:30:00Z';

  // “Scenario now” as a Date in the *zoned* domain
  const sNowZoned = () => utcToZonedTime(new Date(SCENARIO_ANCHOR_UTC), SCENARIO_TZ);
  const minUtc = (a: Date, b: Date) => new Date(Math.min(a.getTime(), b.getTime()));

  // Generic helpers: do calendar math *in the zone*, then convert to UTC for the API
  const toZoned = (d: Date) => utcToZonedTime(d, SCENARIO_TZ);
  const fromZoned = (d: Date) => zonedTimeToUtc(d, SCENARIO_TZ);

  const startOfZonedDayUtc = (d: Date) => fromZoned(startOfDay(toZoned(d)));
  const endOfZonedDayUtc   = (d: Date) => fromZoned(endOfDay(toZoned(d)));

  const startOfZonedWeekUtc = (d: Date) => fromZoned(startOfWeek(toZoned(d), { weekStartsOn: 1 }));
  const endOfZonedWeekUtc   = (d: Date) => fromZoned(endOfWeek(toZoned(d),   { weekStartsOn: 1 }));

  const startOfZonedMonthUtc = (d: Date) => fromZoned(startOfMonth(toZoned(d)));
  const endOfZonedMonthUtc   = (d: Date) => fromZoned(endOfMonth(toZoned(d)));

  const subZonedDaysUtc = (d: Date, n: number) => fromZoned(subDays(toZoned(d), n));

  // For formatting labels (no TZ text shown, but pinned to scenario zone)
  const fmtYmd = (dUtc: Date) => formatInTimeZone(dUtc, SCENARIO_TZ, 'MMM d, yyyy');

  const isScenarioToday = (d: Date) =>
    formatInTimeZone(d, SCENARIO_TZ, 'yyyy-MM-dd') === SCENARIO_TODAY_YMD;


  // ---------------- Your component state (keep the same shape) ----------------
  type SelectionRange = { startDate: Date; endDate: Date; key: 'selection' };

  // Initial range: “last 14 days up to scenario now”
  const anchorZ = sNowZoned();
  const initialRange: SelectionRange = {
    startDate: startOfZonedDayUtc(subZonedDaysUtc(anchorZ, 0)),
    endDate: endOfZonedDayUtc(anchorZ),
    key: 'selection',
  };

  // --- helpers to compare *calendar days* in the scenario zone ---
  const ymdInScenario = (d: Date) => formatInTimeZone(d, SCENARIO_TZ, 'yyyy-MM-dd');
  const SCENARIO_TODAY_YMD = ymdInScenario(sNowZoned());

  const isAfterScenarioDay = (d: Date) => ymdInScenario(d) > SCENARIO_TODAY_YMD;
  

  const [pendingRange, setPendingRange] = useState<SelectionRange>(initialRange);
  const [appliedRange, setAppliedRange] = useState<SelectionRange>(initialRange);
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const open = Boolean(anchorEl);

  const handleOpen = (e: React.MouseEvent<HTMLElement>) => {
    if (isPreview) return;
    setAnchorEl(e.currentTarget);
  };
  const handleClose = () => setAnchorEl(null);

  // Normalize by snapping to start/end of *scenario* day; keep UTC for API
  const normalizeRange = (r: SelectionRange): SelectionRange => {
    let s = startOfZonedDayUtc(r.startDate);
    let e = endOfZonedDayUtc(r.endDate);
    if (isAfter(s, e)) e = endOfZonedDayUtc(s);
    return { startDate: s, endDate: e, key: 'selection' };
  };

  const applyAndClose = (r: SelectionRange) => {
    const R = normalizeRange(r);
    setPendingRange(R);
    setAppliedRange(R);
    setSelectingEnd(false);
    handleClose();
  };
  const handleApply = () => applyAndClose(pendingRange);

  // Single-calendar range selection
  const [selectingEnd, setSelectingEnd] = useState(false);
  const handleDaySelect = (date: Date | null) => {
    if (!date || isPreview) return;
    // Interpret the clicked calendar day as a *scenario-zone* day [00:00–23:59:59.999],
    // then store UTC instants
    if (isAfterScenarioDay(date)) return;
    setPendingRange((r) => {
      if (!selectingEnd) {
        setSelectingEnd(true);
        const startUtc = startOfZonedDayUtc(date);
        const endUtc   = endOfZonedDayUtc(date);
        return { ...r, startDate: startUtc, endDate: endUtc };
      }
      const startUtc = r.startDate;
      // Compare as UTC timestamps, but compute min/max in terms of the same “day” clicks
      const sFirst = startUtc.getTime() <= date.getTime();
      const sUtc = sFirst ? startOfZonedDayUtc(startUtc) : startOfZonedDayUtc(date);
      const eUtc = sFirst ? endOfZonedDayUtc(date)        : endOfZonedDayUtc(startUtc);
      setSelectingEnd(false);
      return { ...r, startDate: sUtc, endDate: eUtc };
    });
  };

  // Labels: format in scenario zone (no TZ label shown)
  const rangeLabel = useMemo(
    () => `${fmtYmd(appliedRange.startDate)} - ${fmtYmd(appliedRange.endDate)}`,
    [appliedRange]
  );

  // Quick presets (auto-apply), resolved against *scenario now* in the scenario zone
  const presets = [
    {
      label: 'Today',
      get: () => {
        const now = sNowZoned();
        return { startDate: startOfZonedDayUtc(now), endDate: endOfZonedDayUtc(now), key: 'selection' as const };
      }
    },
    {
      label: 'Yesterday',
      get: () => {
        const d = subZonedDaysUtc(sNowZoned(), 1);
        return { startDate: startOfZonedDayUtc(d), endDate: endOfZonedDayUtc(d), key: 'selection' as const };
      }
    },
    {
      label: 'This week',
      get: () => {
        const now = sNowZoned();
        return { startDate: startOfZonedWeekUtc(now), endDate: endOfZonedDayUtc(now), key: 'selection' as const };
      }
    },
    {
      label: 'Last week',
      get: () => {
        const end = endOfZonedWeekUtc(subZonedDaysUtc(startOfZonedWeekUtc(sNowZoned()), 1));
        const start = startOfZonedWeekUtc(end);
        return { startDate: startOfZonedDayUtc(start), endDate: endOfZonedDayUtc(end), key: 'selection' as const };
      }
    },
    {
      label: 'This month',
      get: () => {
        const now = sNowZoned();
        return { startDate: startOfZonedMonthUtc(now), endDate: endOfZonedDayUtc(now), key: 'selection' as const };
      }
    },
    {
      label: 'Last month',
      get: () => {
        const end = endOfZonedMonthUtc(subZonedDaysUtc(startOfZonedMonthUtc(sNowZoned()), 1));
        const start = startOfZonedMonthUtc(end);
        return { startDate: startOfZonedDayUtc(start), endDate: endOfZonedDayUtc(end), key: 'selection' as const };
      }
    },
  ];

  // Calendar day highlighting using scenario zone semantics
  const RangeDay = (props: PickersDayProps<Date> & { start?: Date | null; end?: Date | null }) => {
    const { day, outsideCurrentMonth, start, end, ...other } = props as any;
    // Compare by yyyy-MM-dd *in the scenario zone* to avoid local-TZ drift
    const ymd = (d: Date) => formatInTimeZone(d, SCENARIO_TZ, 'yyyy-MM-dd');
    const isStart = !!start && ymd(day as Date) === ymd(start);
    const isEnd   = !!end   && ymd(day as Date) === ymd(end);
    const inRange = !!start && !!end &&
      (formatInTimeZone(day as Date, SCENARIO_TZ, 'yyyy-MM-dd') >= ymd(start) &&
      formatInTimeZone(day as Date, SCENARIO_TZ, 'yyyy-MM-dd') <= ymd(end)) &&
      !isStart && !isEnd;

    return (
      <PickersDay
        {...(other as any)}
        outsideCurrentMonth={outsideCurrentMonth}
        day={day as any}
        today={isScenarioToday(day as Date)}     
        selected={isStart || isEnd}
        data-eid={`calendar.day.${ymd(day as Date)}`}   // stable id
        data-areaid="dashboard-calendar"
        sx={{ ...(inRange && { bgcolor: (t) => alpha(t.palette.primary.main, 0.2) }) }}
      />
    );
  };

  // —— Backend facet (send exactly what the UI shows) ——
  const facetForApi: 'status' | 'consumption' | 'productivity' = effectiveView;

  const targetBarsByView: Record<ViewKey, number> = {
    status: 72,          // chunky bars, readable
    consumption: 72,    // more points for smoother lines
    productivity: 72,
  };

  const bucketForApi = useMemo(() => {
    return pickAdaptiveBucket(appliedRange.startDate, appliedRange.endDate, targetBarsByView[effectiveView]);
  }, [appliedRange.startDate, appliedRange.endDate, effectiveView]);

  const { data, loading, error } = useDashboardData({
    from: appliedRange.startDate,
    to: appliedRange.endDate,
    facet: facetForApi,
    bucket: bucketForApi,
    // machineIds: [] // add when you have machine filters
  });

  // ---------- Derive simple tiles from the returned series (new API fields) ----------
  const series = (data?.series ?? []) as any[];

  // Latest bucket per machine → for current power
  const byMachineLatest = useMemo(() => {
    const map = new Map<string, { t: number; power?: number | null }>();
    for (const r of series) {
      if (!r.machine_id || !r.t_bucket) continue;
      const t = new Date(r.t_bucket as string).getTime();
      const prev = map.get(r.machine_id as string);
      if (!prev || t > prev.t) map.set(r.machine_id as string, { t, power: (r as any).power ?? null });
    }
    return map;
  }, [series]);

  const machinesCount = useMemo(() => {
    const s = new Set<string>();
    for (const r of series) if (r.machine_id) s.add(r.machine_id as string);
    return s.size;
  }, [series]);

  // STATUS facet: average durations per machine across the selected period (seconds)
  const statusAgg = useMemo(() => {
    let working = 0, idle = 0, alarm = 0;
    for (const r of series) {
      if ('working_time' in r) {
        working += Number((r as any).working_time || 0);
        idle    += Number((r as any).idle_time || 0);
        alarm   += Number((r as any).alarm_time || 0);
      }
    }
    const denom = Math.max(1, machinesCount);
    return {
      avgWorkingSec: working / denom,
      avgIdleSec:    idle    / denom,
      avgAlarmSec:   alarm   / denom,
    };
  }, [series, machinesCount]);

  const avgUtilization = useMemo(() => {
    let sum = 0, n = 0;
    for (const r of series) {
      const u = (r as any).utilization_rate;
      if (u != null) { sum += Number(u); n++; }
    }
    return n ? (sum / n) : null; // already 0–100 from API
  }, [series]);

  // CONSUMPTION/POWER
  const totalConsumptionKwh = useMemo(() => {
    if (facetForApi !== 'consumption') return 0;
    let sum = 0;
    for (const r of series) sum += Number((r as any).consumption_total || 0);
    return sum;
  }, [series, facetForApi]);

  const currentPowerKw = useMemo(() => {
    if (facetForApi !== 'consumption') return 0;
    let sum = 0;
    for (const [, v] of byMachineLatest) sum += Number(v.power ?? 0);
    return sum;
  }, [byMachineLatest, facetForApi]);

  const { sawCost, totalCost } = useMemo(() => {
    let saw = false, sum = 0;
    for (const r of series) {
      const c = (r as any).cost;
      if (c != null) { saw = true; sum += Number(c); }
    }
    return { sawCost: saw, totalCost: sum };
  }, [series]);

  const bucketMinutes = parseBucketToMinutes(data?.bucket) ?? 60;

  const statusByMachine = useMemo(() => {
    if (!series.length) return new Map<string, any[]>();
    const map = new Map<string, any[]>();
    for (const r of series) {
      const id = (r as any).machine_id;
      if (!id) continue;
      if (!map.has(id)) map.set(id, []);
      map.get(id)!.push(r);
    }
    // sort each machine's rows by time
    for (const [k, arr] of map) {
      arr.sort((a, b) => new Date(a.t_bucket).getTime() - new Date(b.t_bucket).getTime());
    }
    return map;
  }, [series]);

  // PRODUCTIVITY
  const productivity = useMemo(() => {
    let oeeSum=0, availSum=0, perfSum=0, qualSum=0, nOee=0, nAvail=0, nPerf=0, nQual=0;
    let cycles=0, good=0, bad=0, actSum=0, nAct=0, accSum=0, nAcc=0;
    for (const r of series) {
      const rr = r as any;
      if (rr.oee != null)          { oeeSum += Number(rr.oee); nOee++; }
      if (rr.availability != null) { availSum += Number(rr.availability); nAvail++; }
      if (rr.performance != null)  { perfSum += Number(rr.performance); nPerf++; }
      if (rr.quality != null)      { qualSum += Number(rr.quality); nQual++; }
      if (rr.cycles != null)       cycles += Number(rr.cycles);
      if (rr.good_cycles != null)  good   += Number(rr.good_cycles);
      if (rr.bad_cycles != null)   bad    += Number(rr.bad_cycles);
      if (rr.avg_cycle_time != null) { actSum += Number(rr.avg_cycle_time); nAct++; }
      if (rr.avg_cycle_cost != null) { accSum += Number(rr.avg_cycle_cost); nAcc++; }
    }
    return {
      oee: nOee ? oeeSum / nOee : null,
      availability: nAvail ? availSum / nAvail : null,
      performance: nPerf ? perfSum / nPerf : null,
      quality: nQual ? qualSum / nQual : null,
      cycles, good, bad,
      avgCycleTime: nAct ? actSum / nAct : null,
      avgCycleCost: nAcc ? accSum / nAcc : null,
    };
  }, [series]);

  const fmtHHMMSS = (secs: number | null | undefined) => {
    if (secs == null || Number.isNaN(secs)) return '—';
    const s = Math.max(0, Math.floor(secs));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(h)}:${pad(m)}:${pad(ss)}`;
  };

  const metricTiles = useMemo(() => {
    if (effectiveView === 'status') {
      return [
        { label: 'Machines',              value: String(machinesCount) },
        { label: 'Average working time',  value: fmtHHMMSS(statusAgg.avgWorkingSec) },
        { label: 'Average idle time',     value: fmtHHMMSS(statusAgg.avgIdleSec) },
        { label: 'Average alarm time',    value: fmtHHMMSS(statusAgg.avgAlarmSec) },
        { label: 'Average utilization rate', value: avgUtilization == null ? '—' : `${avgUtilization.toFixed(1)} %` },
      ];
    }

    if (effectiveView === 'consumption') {
      return [
        { label: 'Current power',       value: `${currentPowerKw.toFixed(1)} kW` },
        { label: 'Total consumption',   value: `${totalConsumptionKwh.toFixed(0)} kWh` },
        { label: 'Total costs',         value: sawCost ? `${totalCost.toFixed(2)} €` : '—' },
      ];
    }

    // productivity
    return [
      //{ label: 'OEE',                 value: productivity.oee == null ? '—' : `${productivity.oee.toFixed(1)} %` },
      //{ label: 'Availability',        value: productivity.availability == null ? '—' : `${productivity.availability.toFixed(1)} %` },
      //{ label: 'Performance',         value: productivity.performance == null ? '—' : `${productivity.performance.toFixed(1)} %` },
      //{ label: 'Quality',             value: productivity.quality == null ? '—' : `${productivity.quality.toFixed(1)} %` },
      //{ label: 'Cycles',              value: String(productivity.cycles) },
      //{ label: 'Good cycles',         value: String(productivity.good) },
      //{ label: 'Bad cycles',          value: String(productivity.bad) },
      { label: 'Average cycle time',  value: productivity.avgCycleTime == null ? '—' : `${productivity.avgCycleTime.toFixed(1)} s` },
      { label: 'Average cycle cost',  value: productivity.avgCycleCost == null ? '—' : `${productivity.avgCycleCost.toFixed(3)} €` },
    ];
  }, [effectiveView, machinesCount, statusAgg, currentPowerKw, totalConsumptionKwh, sawCost, totalCost, productivity]);


  // telemetry
  const { pathname } = useLocation();

  // single machine view
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [overlayMachineId, setOverlayMachineId] = useState<string | null>(null);
  const [overlayMachineName, setOverlayMachineName] = useState<string | undefined>(undefined);
  const [overlayFacet, setOverlayFacet] = useState<ViewKey | null>(null);
  

  // open/close
  const openMachineOverlay = (id: string, name?: string) => {
    setOverlayMachineId(id);
    setOverlayMachineName(name);
    setOverlayFacet(effectiveView);   // lock to the facet where click happened
    setOverlayOpen(true);
  };
  const closeMachineOverlay = () => {
    setOverlayOpen(false);
    setOverlayMachineId(null);
    setOverlayMachineName(undefined);
    setOverlayFacet(null);
  };

  const seriesByMachine = useMemo(() => {
    const map = new Map<string, any[]>();
    for (const r of series) {
      const id = (r as any).machine_id;
      if (!id) continue;
      const arr = map.get(id) ?? [];
      arr.push(r);
      map.set(id, arr);
    }
    // sort each machine’s rows by time ascending
    for (const [k, arr] of map) {
      arr.sort((a, b) => new Date(a.t_bucket).getTime() - new Date(b.t_bucket).getTime());
    }
    return map;
  }, [series]);

  const overlayRows = useMemo(() => {
    if (!overlayMachineId) return [];
    return seriesByMachine.get(overlayMachineId) ?? [];
  }, [overlayMachineId, seriesByMachine]);

  return (
    <Box data-areaid="dashboard-shell" data-eid="dash.shell">
      <Box
        ref={topAnchorRef}
        sx={(t) => ({
          height: 0,                  // invisible
          // make sure the anchor stops *below* any fixed header in StudyLayout
          // 64px = typical AppBar; tweak if yours differs
          scrollMarginTop: `calc(${t.spacing(2)} + 64px)`,
        })}
      />
      {/* ——— Top bar: view switcher + date filter ——— */}
      <Box 
          data-areaid="dashboard-topbar"
          data-eid="dash.topbar"
          sx={(t) => ({
          position: 'sticky',
          // If your page/content container has top padding (often 16 = t.spacing(2)),
          // offset it so the bar touches the viewport top:
          top: `-${t.spacing(3)}`,                // change to 0 if your container has no top padding
          left: 0,
          right: 0,

          // keep it above cards/charts
          zIndex: t.zIndex.appBar + 2,
          isolation: 'isolate',                   // ensure z-index creates a new stacking context

          // layout
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 2,
          flexWrap: 'wrap',
          py: 1,
          mb: 2,

          // solid background (no translucency, so content won't "show through")
          bgcolor: t.palette.background.paper,
          borderBottom: `1px solid ${t.palette.divider}`,
          boxShadow: `0 2px 8px rgba(0,0,0,0.25)`,
        })}
      >
        <ToggleButtonGroup
          data-tour="view-tabs"
          value={effectiveView}
          exclusive
          onChange={handleViewChange}
          size="small"
          aria-label="Dashboard view"
          disabled={isPreview || overlayOpen} 
        >
          <ToggleButton value="status" data-eid="view.status" aria-label="Status">Status</ToggleButton>
          <ToggleButton value="consumption" data-eid="view.consumption" aria-label="Consumption">Consumption</ToggleButton>
          <ToggleButton value="productivity" data-eid="view.productivity" aria-label="Productivity">Productivity</ToggleButton>
        </ToggleButtonGroup>

        {loading && <Typography variant="body2" color="text.secondary">Updating…</Typography>}
        {error && <Typography variant="body2" color="error">{String(error.message)}</Typography>}

        <Button
          data-tour="date-filter"
          data-eid="calendar.open"
          onClick={handleOpen}
          variant="outlined"
          size="small"
          startIcon={<CalendarMonthIcon />}
          sx={{ ml: 'auto' }}
          disabled={isPreview}
        >
          {rangeLabel}
        </Button>

        <Popover
          open={open}
          anchorEl={anchorEl}
          onClose={handleClose}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
          transformOrigin={{ vertical: 'top', horizontal: 'right' }}
          slotProps={{ paper: { sx: { p: 1 } } }}
          data-eid="calendar.popover"
          data-areaid="dashboard-calendar-popover"
        >
          <Box sx={{ p: 1 }}>
            <LocalizationProvider dateAdapter={AdapterDateFns}>
              <Stack direction="row" spacing={1} sx={{ mb: 1, flexWrap: 'wrap' }}>
                {presets.map((p) => (
                  <Chip
                    key={p.label}
                    label={p.label}
                    size="small"
                    variant="outlined"
                    data-eid={`calendar.preset.${p.label.replace(/\s+/g, '_').toLowerCase()}`}
                    onClick={() => { if (!isPreview) applyAndClose(p.get()); }}
                  />
                ))}
              </Stack>
              <DateCalendar
                value={pendingRange.endDate}
                onChange={handleDaySelect}
                shouldDisableDate={(day) => !day || isAfterScenarioDay(day)}
                slots={{ day: RangeDay }}
                slotProps={{ day: { start: pendingRange.startDate, end: pendingRange.endDate } }}
                disabled={isPreview}
                data-eid="calendar.date"
              />
              <Divider sx={{ my: 1 }} />
              <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Button variant="contained" onClick={handleApply} disabled={isPreview} data-eid="calendar.apply">Apply</Button>
              </Box>
            </LocalizationProvider>
          </Box>
        </Popover>
      </Box>

      {/* ——— STATUS VIEW ——— */}
      {effectiveView === 'status' && (
        <>
          <Box data-areaid="dash.metrics" data-eid="dash.metrics">
            <Grid container spacing={2}>
              {metricTiles.map((m) => (
                <Grid key={m.label} item xs={12} md={4}>
                  <Card sx={{ height: '100%' }}>
                    <CardContent>
                      <Typography variant="caption">{m.label}</Typography>
                      <Typography variant="h5">{m.value}</Typography>
                    </CardContent>
                  </Card>
                </Grid>
              ))}
            </Grid>
          </Box>

          <Box sx={{ height: 24 }} data-areaid="dash.utilization_rows" data-eid="dash.utilization_rows"/>
          {Array.from(statusByMachine.entries()).map(([machineId, rows]) => (
            <Box key={machineId} sx={{ mt: 2 }}>
              <MachineUtilizationRow
                data-tour="machine-page"
                machineType="Production machine"
                statusRows={rows}          
                from={appliedRange.startDate}
                to={appliedRange.endDate}
                rowBucketMinutes={bucketMinutes}
                displayTz={SCENARIO_TZ}
                respectNow={false}
                respectLastData={false}

                // ► avoid re-snapping to the OS local midnight
                snapStartToMidnight={false}
                snapEndToEndOfDay={false}
                // stepMinutes is ignored in rows mode; rowBucketMinutes wins
                onNameClick={() => openMachineOverlay(machineId, rows?.[0]?.machine_name)}
              />
            </Box>
          ))}

          <Box sx={{ height: 24 }} />
          <Box data-tour="machine-table" data-areaid="dash.machine_table" data-eid="dash.machine_table">
            {/* temporarily empty until we wire the new "machines" dataset */}
            <MachineTable facet="status" series={series}  onNameClick={({ id, name }) => openMachineOverlay(id, name)}/>
          </Box>
        </>
      )}

      {/* ——— CONSUMPTION VIEW ——— */}
      {effectiveView === 'consumption' && (
        <>
          <Box data-areaid="dash.metrics" data-eid="dash.metrics">
            <Grid container spacing={2}>
              {metricTiles.map((m) => (
                <Grid key={m.label} item xs={12} md={4}>
                  <Card sx={{ height: '100%' }}>
                    <CardContent>
                      <Typography variant="caption">{m.label}</Typography>
                      <Typography variant="h5">{m.value}</Typography>
                    </CardContent>
                  </Card>
                </Grid>
              ))}
            </Grid>
          </Box>
          <Box sx={{ height: 24 }} />
          <Box data-tour="chart-area" data-areaid="dash.chart_area" data-eid="dash.chart_area">
            {/* keep mocks until we adapt TrendChart to the new series */}
            <TrendChart variant="consumption" data={series} serverStepMin={bucketMinutes} showAverageLine data-tour="chart-area" data-areaid="dash.chart.consumption" data-eid="dash.chart.consumption" />
          </Box>
          <Box sx={{ height: 24 }} />
          <TrendChart variant="power" data={series} serverStepMin={bucketMinutes} showAverageLine smoothing="ewma" data-areaid="dash.chart.power" data-eid="dash.chart.power" />
          <Box sx={{ height: 24 }} />
          <Box data-tour="machine-table" data-areaid="dash.machine_table" data-eid="dash.machine_table">
            <MachineTable facet="consumption" series={series} onNameClick={({ id, name }) => openMachineOverlay(id, name)} />
          </Box>
        </>
      )}

      {/* ——— PRODUCTIVITY VIEW ——— */}
      {effectiveView === 'productivity' && (
        <>
          <Box data-areaid="dash.metrics" data-eid="dash.metrics">
            <Grid container spacing={2}>
              <Grid item xs={12} md={6} lg={4}>
                <OeeSummaryTile
                  oee={productivity.oee}
                  availability={productivity.availability}
                  performance={productivity.performance}
                  quality={productivity.quality}
                />
              </Grid>
              <Grid item xs={12} md={6} lg={4}>
                <CyclesTile
                  cycles={productivity.cycles}
                  goodCycles={productivity.good}
                  badCycles={productivity.bad}
                />
              </Grid>
              {metricTiles.map((m) => (
                <Grid key={m.label} item xs={12} md={4}>
                  <Card sx={{ height: '100%' }}>
                    <CardContent>
                      <Typography variant="caption">{m.label}</Typography>
                      <Typography variant="h5">{m.value}</Typography>
                    </CardContent>
                  </Card>
                </Grid>
              ))}
            </Grid>
          </Box>

          <Box sx={{ height: 24 }}/>
          <TrendChart variant="oee" data={series} serverStepMin={bucketMinutes} avgExcludeZeros showAverageLine  data-areaid="dash.chart-oee" data-eid="dash.chart.oee" />
          <Box sx={{ height: 24 }} />
          <TrendChart variant="cycles" data={series} serverStepMin={bucketMinutes} unitOverride="cycles" avgExcludeZeros showAverageLine data-areaid="dash.chart-cycles" data-eid="dash.chart.cycles"/>
          <Box sx={{ height: 24 }} />
          <Box data-tour="machine-table" data-areaid="dash.machine_table" data-eid="dash.machine_table">
            <MachineTable facet="productivity" series={series} onNameClick={({ id, name }) => openMachineOverlay(id, name)} />
          </Box>
        </>
      )}

      {/* ——— Overlay ——— */}
      {overlayOpen && overlayMachineId && overlayFacet && (
        <MachineOverlayPanel
          open={overlayOpen}
          onClose={closeMachineOverlay}
          facet={overlayFacet}   // only these two for now
          machineId={overlayMachineId}
          machineName={overlayMachineName}
          rows={overlayRows}
          serverStepMin={bucketMinutes}
          from={appliedRange.startDate}
          to={appliedRange.endDate}
          scenarioAnchorUtc={SCENARIO_ANCHOR_UTC}
          scenarioTz={SCENARIO_TZ}
        />
      )}
    </Box>
  );
}
