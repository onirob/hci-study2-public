import * as React from 'react';
import {
  Card, Box, Stack, Typography, Chip, Tooltip, alpha, useTheme, Link as MUILink,
} from '@mui/material';
import PauseIcon from '@mui/icons-material/Pause';
import PlayArrowRoundedIcon from '@mui/icons-material/PlayArrowRounded';
import PowerSettingsNewRoundedIcon from '@mui/icons-material/PowerSettingsNewRounded';
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded';
import { formatInTimeZone, utcToZonedTime, zonedTimeToUtc } from 'date-fns-tz';

import type { StatusRow } from '../../hooks/useDashboardData';

/** =================== Single Machine Utilization Row =================== */

export type StateKind = 'working' | 'idle' | 'offline' | 'alarm';

export type Slice = {
  start: string; // ISO8601
  end: string;   // ISO8601
  state: StateKind;
};

export type Machine = {
  id: string;
  name: string;
  machineType?: string;
  slices: Slice[];
};

type HourBin = {
  start: Date;
  end: Date;
  minutes: { working: number; idle: number; offline: number; alarm: number };
};

/* -------------------- time helpers -------------------- */
// NEW helpers — anchor to local wall-clock but keep UTC instants
const MIN = 60_000;

function floorToStepZoned(utc: Date, stepMin: number, tz: string) {
  const local = utcToZonedTime(utc, tz);
  local.setSeconds(0, 0);

  const mins = local.getHours() * 60 + local.getMinutes();
  const floored = Math.floor(mins / stepMin) * stepMin;

  local.setHours(Math.floor(floored / 60), floored % 60, 0, 0);
  return zonedTimeToUtc(local, tz);
}


function addMinutesZoned(utc: Date, minutes: number, tz: string) {
  const local = utcToZonedTime(utc, tz);
  local.setMinutes(local.getMinutes() + minutes, 0, 0);
  return zonedTimeToUtc(local, tz);
}

// Tooltip label: compute end in the zoned domain to avoid 01:00–01:00
function fmtHourRangeTZ(startUtc: Date, endUtc: Date, tz: string, use12h = true) {
  const stepMin = Math.round((endUtc.getTime() - startUtc.getTime()) / MIN);
  const sLocal = utcToZonedTime(startUtc, tz);
  const eLocal = new Date(sLocal.getTime()); eLocal.setMinutes(eLocal.getMinutes() + stepMin);

  const day = formatInTimeZone(startUtc, tz, 'dd MMM');
  const tf  = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: use12h, timeZone: tz });
  return `${day}, ${tf.format(sLocal)} - ${tf.format(eLocal)}`;
}

const normDate = (v: Date | string) => (v instanceof Date ? new Date(v) : new Date(v));
const startOfLocalDay = (d: Date) => { const x = new Date(d); x.setHours(0,0,0,0); return x; };
const endOfLocalDay   = (d: Date) => { const x = new Date(d); x.setHours(24,0,0,0); return x; };

const floorToStep = (d: Date, stepMin: number) =>
  new Date(Math.floor(d.getTime() / (stepMin * MIN)) * (stepMin * MIN));

const addMinutes = (d: Date, minutes: number) =>
  new Date(d.getTime() + minutes * MIN);

const overlapMinutes = (a0: Date, a1: Date, b0: Date, b1: Date) => {
  const s = Math.max(a0.getTime(), b0.getTime());
  const e = Math.min(a1.getTime(), b1.getTime());
  return Math.max(0, (e - s) / 60000);
};
const lastDataInstant = (slices: Slice[]): Date | null =>
  slices.length ? new Date(Math.max(...slices.map(s => new Date(s.end).getTime()))) : null;

// Snap midnight IN A ZONE, but return UTC instants
const startOfZonedDayUtc = (dUtc: Date, tz: string) => {
  const z = utcToZonedTime(dUtc, tz);
  z.setHours(0, 0, 0, 0);
  return zonedTimeToUtc(z, tz);
};
const endOfZonedDayUtc = (dUtc: Date, tz: string) => {
  const z = utcToZonedTime(dUtc, tz);
  z.setHours(23, 59, 59, 999);
  return zonedTimeToUtc(z, tz);
};

function capBins(bins: HourBin[], maxBars: number): HourBin[] {
  if (!bins.length || bins.length <= maxBars) return bins;
  const k = Math.ceil(bins.length / maxBars); // group size
  const out: HourBin[] = [];
  for (let i = 0; i < bins.length; i += k) {
    const group = bins.slice(i, i + k);
    const start = group[0].start;
    const end   = group[group.length - 1].end;
    const minutes = { working: 0, idle: 0, offline: 0, alarm: 0 };
    for (const b of group) {
      minutes.working += b.minutes.working;
      minutes.idle    += b.minutes.idle;
      minutes.offline += b.minutes.offline;
      minutes.alarm   += b.minutes.alarm;
    }
    out.push({ start, end, minutes });
  }
  return out;
}

/* -------------------- binning -------------------- */
function binToStepZoned(
  slices: Slice[],
  fromUtc: Date,
  toUtc: Date,
  stepMin: number,
  tz: string
): HourBin[] {
  const hardTo = floorToStepZoned(toUtc, stepMin, tz);
  let cur = floorToStepZoned(fromUtc, stepMin, tz);
  const out: HourBin[] = [];

  while (cur < hardTo) {
    const next = addMinutesZoned(cur, stepMin, tz);
    const binLenMin = (next.getTime() - cur.getTime()) / MIN;

    const bin: HourBin = {
      start: cur,
      end: next,
      minutes: { working: 0, idle: 0, offline: 0, alarm: 0 },
    };

    for (const s of slices) {
      const ss = new Date(s.start);
      const ee = new Date(s.end);
      const mins = overlapMinutes(cur, next, ss, ee);
      if (mins <= 0) continue;
      if (s.state === 'alarm') bin.minutes.alarm += mins;
      else bin.minutes[s.state] += mins;
    }

    // fill empty bin with its *actual* length (handles 23/25h DST days)
    const filled = bin.minutes.working + bin.minutes.idle + bin.minutes.offline + bin.minutes.alarm;
    if (filled === 0) bin.minutes.offline = binLenMin;

    out.push(bin);
    cur = next;
  }
  return out;
}

function dominantState(bin: HourBin): Exclude<StateKind, 'alarm'> {
  const { working, idle, offline } = bin.minutes;
  const total = working + idle + offline;
  if (total <= 0) return 'offline';
  if (working >= idle && working >= offline) return 'working';
  if (idle >= working && idle >= offline) return 'idle';
  return 'offline';
}

function sumMinutes(bins: HourBin[], key: keyof HourBin['minutes']): number {
  return bins.reduce((acc, b) => acc + b.minutes[key], 0);
}

const fmtHMS = (mins: number) => {
  const sTotal = Math.round(mins * 60);
  const h = Math.floor(sTotal / 3600);
  const m = Math.floor((sTotal % 3600) / 60);
  const s = sTotal % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
};
const fmtHourRange = (start: Date, end: Date) => {
  const d = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short' }).format(start);
  const t = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: true });
  return `${d}, ${t.format(start)} - ${t.format(end)}`;
};

function pickStepMinutes(
  from: Date,
  to: Date,
  targetBars = 72,                        // ~60–90 bars is readable
  allowed: number[] = [15,30,60,90]
) {
  const totalMin = Math.max(1, Math.floor((to.getTime() - from.getTime()) / 60000));
  const rawNeeded = Math.ceil(totalMin / targetBars);     // minutes per bar to hit target
  for (const s of allowed) if (s >= rawNeeded) return s;   // first allowed ≥ needed
  return allowed[allowed.length - 1];
}

function lowerBoundIdx(rows: StatusRow[], t: number) {
  let lo = 0, hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (new Date(rows[mid].t_bucket).getTime() < t) lo = mid + 1;
    else hi = mid;
  }
  return lo; // first index with time >= t
}


/* ==========================================================
   Single Row (15-minute bars) with built-in range handling
   ========================================================== */
  export function MachineUtilizationRow({
    name,                    // <-- make optional
    machineType = 'Production machine',
    statusRows,
    rowBucketMinutes,
    slices = [],
    from,
    to,
    stepMinutes,
    now: nowOverride,
    respectNow = true,
    respectLastData = true,
    snapStartToMidnight = false,
    snapEndToEndOfDay = false,
    autoStep = true,
    targetBars = 72,
    displayTz = 'Europe/Rome', 
    onNameClick,
  }: {
    name?: string;            
    machineType?: string;
    statusRows?: StatusRow[];
    rowBucketMinutes?: number;
    slices?: Slice[];
    from: Date | string;
    to: Date | string;
    stepMinutes?: number;
    now?: Date;
    respectNow?: boolean;
    respectLastData?: boolean;
    snapStartToMidnight?: boolean;
    snapEndToEndOfDay?: boolean;
    autoStep?: boolean;
    targetBars?: number;
    displayTz?: string;  
    onNameClick?: () => void;
  }) {
    const theme = useTheme();
    const now = nowOverride ?? new Date();


    const containerRef = React.useRef<HTMLDivElement | null>(null);
    const [hoverIdx, setHoverIdx] = React.useState<number | null>(null);

    const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
      const el = containerRef.current;
      if (!el || visBins.length === 0) return;
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const cellW = rect.width / visBins.length;
      const idx = Math.min(visBins.length - 1, Math.max(0, Math.floor(x / cellW)));
      setHoverIdx(idx);
    };
    const handleMouseLeave = () => setHoverIdx(null);

    const tooltipForIdx = (idx: number | null) => {
      if (idx == null) return null;
      const b = visBins[idx];
      if (!b) return null;
      const total = b.minutes.working + b.minutes.idle + b.minutes.offline;
      const pctWork = total ? b.minutes.working / total : 0;
      const pctIdle = total ? b.minutes.idle / total : 0;
      const pctOff  = total ? b.minutes.offline / total : 0;
      return (
        <Stack spacing={0.6}>
          <Typography sx={{ fontWeight: 700 }}>{fmtHourRangeTZ(b.start, b.end, displayTz, true)}</Typography>
          <Typography>Working: {fmtPct.format(pctWork)} ({fmtMinutes(b.minutes.working)})</Typography>
          <Typography>Idle: {fmtPct.format(pctIdle)} ({fmtMinutes(b.minutes.idle)})</Typography>
          <Typography>Offline: {fmtPct.format(pctOff)} ({fmtMinutes(b.minutes.offline)})</Typography>
          <Typography>Alarm: {b.minutes.alarm > 0 ? 'Yes' : 'No'} ({fmtMinutes(b.minutes.alarm)})</Typography>
        </Stack>
      );
    };


    // normalize incoming range (local days)
    let rangeStart = normDate(from);
    let rangeEnd   = normDate(to);
    if (snapStartToMidnight) rangeStart = startOfZonedDayUtc(rangeStart, displayTz);
    if (snapEndToEndOfDay)   rangeEnd   = endOfZonedDayUtc(rangeEnd, displayTz);
    
    // pick source mode
    const usingRows = !!(statusRows && statusRows.length);

    const resolvedName = React.useMemo(() => {
      if (name) return name;
      if (usingRows) return statusRows?.[0]?.machine_name ?? 'Machine';
      return 'Machine';
    }, [name, usingRows, statusRows]);

    const rowsSorted = React.useMemo(
      () =>
        usingRows
          ? (statusRows ?? []).slice().sort(
              (a, b) => new Date(a.t_bucket).getTime() - new Date(b.t_bucket).getTime()
            )
          : [],
      [usingRows, statusRows]
    );

    const lastEnd = React.useMemo(() => {
      if (usingRows) {
        if (!rowsSorted.length) return null;
        const stepGuessMin = rowBucketMinutes
          ? rowBucketMinutes
          : rowsSorted.length >= 2
            ? Math.max(
                1,
                Math.round(
                  (new Date(rowsSorted[1].t_bucket).getTime() -
                  new Date(rowsSorted[0].t_bucket).getTime()) / 60000
                )
              )
            : 60; // fallback
        const lastStart = new Date(rowsSorted[rowsSorted.length - 1].t_bucket);
        return addMinutes(lastStart, stepGuessMin);
      }
      return lastDataInstant(slices);
    }, [usingRows, rowsSorted, rowBucketMinutes, slices]);

    const toTs = Math.min(
      rangeEnd.getTime(),
      respectNow ? now.getTime() : Number.POSITIVE_INFINITY,
      (respectLastData && lastEnd) ? lastEnd.getTime() : Number.POSITIVE_INFINITY
    );
    const unclampedTo = new Date(toTs);

 
    const effStep = React.useMemo(() => {
      if (usingRows) {
        if (rowBucketMinutes) return rowBucketMinutes;
        if (rowsSorted.length >= 2) {
          const d0 = new Date(rowsSorted[0].t_bucket).getTime();
          const d1 = new Date(rowsSorted[1].t_bucket).getTime();
          return Math.max(1, Math.round((d1 - d0) / 60000));
        }
        return 60;
      }
      return stepMinutes ?? (autoStep ? pickStepMinutes(rangeStart, unclampedTo, targetBars) : 15);
    }, [usingRows, rowsSorted, rowBucketMinutes, stepMinutes, autoStep, rangeStart, unclampedTo, targetBars]);

    // floor "to" to last completed bin with chosen step
    const hardTo = floorToStepZoned(unclampedTo, effStep, displayTz);

  // ---- Build bins (rows ⇒ dynamic groups) ----
  const bins = React.useMemo<HourBin[]>(() => {
    if (hardTo <= rangeStart) return [];

    if (usingRows) {
      if (!rowsSorted.length) return [];

      // slice rows by time window using binary search
      const i0 = lowerBoundIdx(rowsSorted, rangeStart.getTime());
      const i1 = lowerBoundIdx(rowsSorted, hardTo.getTime());
      const windowRows = rowsSorted.slice(i0, i1);
      if (!windowRows.length) return [];

      const baseStep = effStep;
      // server-bucketed? don't group further
      const groupSize = rowBucketMinutes ? 1 : Math.max(1, Math.ceil(windowRows.length / targetBars));

      const toMin = (s: number | null | undefined) =>
        Math.max(0, Math.round((Number(s || 0) / 60) * 100) / 100);

      const out: HourBin[] = [];
      for (let i = 0; i < windowRows.length; i += groupSize) {
        const group = windowRows.slice(i, i + groupSize);

        // ► anchor to local grid
        const start = rowBucketMinutes
          ? floorToStepZoned(new Date(group[0].t_bucket), rowBucketMinutes, displayTz)
          : floorToStepZoned(new Date(group[0].t_bucket), baseStep, displayTz);

        const end = addMinutesZoned(start, (rowBucketMinutes ?? baseStep) * group.length, displayTz);

        // accumulate minutes (do NOT round per-row; avoid drift)
        let w = 0, idle = 0, off = 0, alarm = 0;
        for (const r of group) {
          w     += (Number(r.working_time)  || 0) / 60;
          idle  += (Number(r.idle_time)     || 0) / 60;
          off   += (Number(r.offline_time)  || 0) / 60;
          alarm += (Number(r.alarm_time)    || 0) / 60;
        }

        // ► if empty, fill with this bin's *actual* length (handles 0/60/120 during DST)
        const binLenMin = Math.max(0, (end.getTime() - start.getTime()) / MIN);
        const filled = w + idle + off + alarm;
        if (filled === 0) off = binLenMin;

        out.push({ start, end, minutes: { working: w, idle, offline: off, alarm } });
      }
      return out;
    }

    // legacy slices path
    return binToStepZoned(slices, rangeStart, unclampedTo, effStep, displayTz);
  }, [usingRows, rowsSorted, slices, rangeStart.getTime(), hardTo.getTime(), effStep, targetBars, rowBucketMinutes]);

  // Hard-cap the number of rendered bars to targetBars (default 72)
  const visBins = React.useMemo<HourBin[]>(
    () => capBins(bins, targetBars),
    [bins, targetBars]
  );

  const wMin = sumMinutes(bins, 'working');
  const iMin = sumMinutes(bins, 'idle');
  const oMin = sumMinutes(bins, 'offline');
  const aMin = sumMinutes(bins, 'alarm');
  const util = (wMin + iMin + oMin) > 0 ? (wMin / (wMin + iMin + oMin)) : 0;

  const curBin = bins[bins.length - 1];
  const curState = curBin ? dominantState(curBin) : 'offline';

  // palette
  const cWorkDark = theme.palette.info.dark || theme.palette.primary.dark;   // dark blue
  const cWorkMid  = theme.palette.info.main || theme.palette.primary.main;   // middle blue
  const cIdleLt   = alpha(theme.palette.info.light, 0.9);                    // light blue (idle)
  const cOff      = alpha('#9e9e9e', 0.7);                                    // grey
  const cAlarm    = theme.palette.error.main;

  // Legend uses these too:
  const cWork = cWorkDark;
  const cIdle = cIdleLt;

  // pick bar color per bin
  function barColor(bin: HourBin) {
    const { working, idle, offline } = bin.minutes;

    // Offline-dominant stays grey
    if (offline >= working && offline >= idle) return cOff;

    const active = working + idle;
    if (active <= 0) return cOff;

    const wShare = working / active; // 0..1 over active time (ignores offline)

    // thresholds: tune if you want sharper/softer transitions
    if (wShare >= 0.67) return cWorkDark; // working-dominant
    if (wShare <= 0.33) return cIdleLt;   // idle-dominant
    return cWorkMid;                       // mixed (some work & some idle)
  }

  const fmtPct = new Intl.NumberFormat('en-GB', { style: 'percent', minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const fmtMinutes = (m: number) => {
    const hr = Math.floor(m / 60);
    const mm = Math.round(m % 60);
    return `${hr} hours, ${mm} minutes`;
  };

  return (
    <Card sx={{ p: 2, borderRadius: 2 }}>
      {/* Header */}
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Box>
          <Stack direction="row" spacing={1} alignItems="center">
            <MUILink
              component="button"
              onClick={onNameClick}
              underline="hover"
              sx={{ color: theme.palette.info.main, fontWeight: 600, fontSize: 16 }}
            >
              {resolvedName}
            </MUILink>

            <Chip
              size="small"
              icon={curState === 'working' ? <PlayArrowRoundedIcon /> : curState === 'idle' ? <PauseIcon /> : <PowerSettingsNewRoundedIcon />}
              label={curState[0].toUpperCase() + curState.slice(1)}
              sx={{
                color: '#cfe8ff',
                bgcolor: alpha(cIdle, 0.18),
                borderColor: alpha(cIdle, 0.5),
                borderWidth: 1,
                borderStyle: 'solid',
                height: 28,
                '& .MuiChip-icon': { color: cIdle },
              }}
            />

            {aMin > 0 && (
              <Tooltip title="Alarms present in range">
                <WarningAmberRoundedIcon sx={{ color: cAlarm, opacity: 0.9, ml: 0.5 }} />
              </Tooltip>
            )}
          </Stack>
          <Typography variant="body2" sx={{ color: 'text.secondary', mt: 0.5 }}>
            {machineType}
          </Typography>
        </Box>

        <Box textAlign="right">
          <Typography variant="h4" sx={{ fontWeight: 700 }}>
            {Math.round(util * 100)}%
          </Typography>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            Utilization rate
          </Typography>
        </Box>
      </Stack>

      {/* Timeline */}
      <Box sx={{ mt: 2 }}>
        {/* Bars row */}
        <Tooltip
          open={hoverIdx != null}
          title={tooltipForIdx(hoverIdx)}
          followCursor
          enterTouchDelay={0}
          leaveTouchDelay={150}
        >
          <Box
            ref={containerRef}
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
            sx={{
              display: 'grid',
              gridTemplateColumns: `repeat(${visBins.length}, 1fr)`,
              gap: 0.3,
              alignItems: 'center',
              cursor: visBins.length ? 'pointer' : 'default',
            }}
          >
            {visBins.map((b, idx) => (
              <Box
                key={idx}
                sx={{
                  height: 28,
                  borderRadius: 1.2,
                  bgcolor: barColor(b),
                  border: `1px solid ${alpha('#fff', 0.15)}`,
                }}
              />
            ))}
          </Box>
        </Tooltip>

        {/* Single alarm dash per bar if any alarm in that bin */}
        <Box
          sx={{
            mt: 1,
            display: 'grid',
            gridTemplateColumns: `repeat(${visBins.length}, 1fr)`,
            gap: 0.5,
            alignItems: 'center',
          }}
        >
          {visBins.map((b, idx) => (
            <Box key={idx} sx={{ display: 'flex', justifyContent: 'center', height: 8 }}>
              {b.minutes.alarm > 0 && (
                <Box sx={{ width: 10, height: 4, bgcolor: cAlarm, borderRadius: 1 }} />
              )}
            </Box>
          ))}
        </Box>
      </Box>

      {/* Footer legend */}
      <Stack direction="row" spacing={4} sx={{ mt: 2, color: 'text.secondary' }}>
        <LegendItem color={cWork} label="Working" value={fmtHMS(wMin)} />
        <LegendItem color={cIdle} label="Idle" value={fmtHMS(iMin)} />
        <LegendItem color={cOff}  label="Offline" value={fmtHMS(oMin)} />
        <LegendItem color={cAlarm} label="Alarm" value={fmtHMS(aMin)} />
      </Stack>
    </Card>
  );
}

function LegendItem({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <Stack direction="row" spacing={1} alignItems="center">
      <Box sx={{ width: 10, height: 10, borderRadius: 1, bgcolor: color }} />
      <Typography variant="body2" sx={{ color: '#fff' }}>{label}:</Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>{value}</Typography>
    </Stack>
  );
}

/** =============== Wrapper: shared filter across machines =============== */
export function MachineList({
  machines,
  from,
  to,
  stepMinutes = 15,
  now,
}: {
  machines: Machine[];
  from: Date | string;
  to: Date | string;
  stepMinutes?: number;
  now?: Date;
}) {
  return (
    <Stack spacing={2}>
      {machines.map((m) => (
        <MachineUtilizationRow
          key={m.id}
          name={m.name}
          machineType={m.machineType}
          slices={m.slices}
          from={from}
          to={to}
          stepMinutes={stepMinutes}
          now={now}
          onNameClick={() => {
            console.log('Open machine details:', m.id);
          }}
        />
      ))}
    </Stack>
  );
}

