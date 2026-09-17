// src/components/Dashboard/MachineOverlayPanel.tsx
import * as React from 'react';
import {
  AppBar, Toolbar, IconButton, Typography, Box, Grid, Card, CardContent,
  Stack, Paper, CircularProgress, Divider
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { useTheme } from '@mui/material/styles';
import { formatInTimeZone } from 'date-fns-tz';

import TrendChart from './TrendChart';
import { MachineUtilizationRow } from './MachineUtilizationRow';
import OeeSummaryTile from './OeeSummaryTile';
import CyclesTile from './CyclesTile';
import { useDashboardData } from '../../hooks/useDashboardData';

type Facet = 'status' | 'consumption' | 'productivity';

type Props = {
  open: boolean;
  onClose: () => void;
  facet: Facet;
  machineId: string;
  machineName?: string;

  // rows belong to the *origin* facet (already fetched in Dashboard)
  rows: any[];
  serverStepMin: number;

  from: Date;
  to: Date;
  scenarioAnchorUtc: string; // '2025-11-05T10:30:00Z'
  scenarioTz: string;        // 'Europe/Rome'
};

function fmtHHMMSS(secs: number | null | undefined) {
  if (secs == null || Number.isNaN(secs)) return '—';
  const s = Math.max(0, Math.floor(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(ss)}`;
}

function bucketFromMinutes(m: number): string {
  const map: Record<number, string> = { 15:'15m',30:'30m',60:'1h',120:'2h',240:'4h',360:'6h',720:'12h',1440:'1d' };
  return map[m] ?? `${m}m`;
}

/** Constrain overlay to the dashboard viewport under the sticky top bar. */
function useDashboardViewportUnderTopbar(open: boolean) {
  const [rect, setRect] = React.useState({ top: 0, left: 0, width: 0, height: 0 });

  React.useLayoutEffect(() => {
    if (!open) return;

    const shell = document.querySelector('[data-areaid="dashboard-shell"]') as HTMLElement | null;
    const topbar = document.querySelector('[data-areaid="dashboard-topbar"]') as HTMLElement | null;
    if (!shell) return;

    const compute = () => {
      const shellRect = shell.getBoundingClientRect();
      const tbRect = topbar ? topbar.getBoundingClientRect() : ({ bottom: 0 } as any);

      const top = Math.max(0, Math.max(shellRect.top, tbRect.bottom));
      const left = shellRect.left;
      const width = shellRect.width;
      const height = Math.max(0, window.innerHeight - top);
      setRect({ top, left, width, height });
    };

    compute();

    let ro: ResizeObserver | null = null;
    if ('ResizeObserver' in window) {
      ro = new ResizeObserver(compute);
      ro.observe(document.documentElement);
      ro.observe(shell);
      if (topbar) ro.observe(topbar);
    }
    const onResize = () => compute();
    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('resize', onResize);
      if (ro) ro.disconnect();
    };
  }, [open]);

  return rect;
}

export default function MachineOverlayPanel({
  open, onClose, facet, machineId, machineName, rows, serverStepMin, from, to, scenarioAnchorUtc, scenarioTz
}: Props) {
  const theme = useTheme();
  const name = machineName || machineId;

  
  // Esc to close
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const { top, left, width, height } = useDashboardViewportUnderTopbar(open);
  const rangeLabel = React.useMemo(
    () => `${formatInTimeZone(from, scenarioTz, 'MMM d, yyyy')} – ${formatInTimeZone(to, scenarioTz, 'MMM d, yyyy')}`,
    [from, to, scenarioTz]
  );
  const bucket = bucketFromMinutes(serverStepMin);

  const sortByTime = (arr: any[]) =>
    (arr ?? []).slice().sort((a, b) => new Date(a.t_bucket).getTime() - new Date(b.t_bucket).getTime());

  // Always keep STATUS + CONSUMPTION in sync for this machine (cheap, avoids conditional flicker)
  const { data: statusData, loading: statusLoading } = useDashboardData({
    from, to, facet: 'status', bucket, machineIds: [machineId],
  } as any);
  const { data: consumptionData, loading: consLoading } = useDashboardData({
    from, to, facet: 'consumption', bucket, machineIds: [machineId],
  } as any);

  // Rows per section (origin rows for the active facet; fetched rows for the others)
  const statusRows = React.useMemo(() => {
    const base = facet === 'status' ? rows : (statusData as any)?.series;
    const sorted = sortByTime(base || []);
    return sorted.filter(r => (r as any).machine_id === machineId || !(r as any).machine_id);
  }, [facet, rows, statusData, machineId]);

  const consumptionRows = React.useMemo(() => {
    const base = facet === 'consumption' ? rows : (consumptionData as any)?.series;
    const sorted = sortByTime(base || []);
    return sorted.filter(r => (r as any).machine_id === machineId || !(r as any).machine_id);
  }, [facet, rows, consumptionData, machineId]);

  const prodRows = React.useMemo(() => {
    if (facet !== 'productivity') return [];
    const sorted = sortByTime(rows || []);
    return sorted.filter(r => (r as any).machine_id === machineId || !(r as any).machine_id);
  }, [facet, rows, machineId]);

  // ---------- Aggregations ----------
  const statusAgg = React.useMemo(() => {
    let working = 0, idle = 0, offline = 0, alarm = 0;
    for (const r of statusRows) {
      working += Number((r as any).working_time || 0);
      idle    += Number((r as any).idle_time || 0);
      offline += Number((r as any).offline_time || 0);
      alarm   += Number((r as any).alarm_time || 0);
    }
    const denom = working + idle + offline + alarm;
    return { working, idle, offline, alarm, utilPct: denom ? (working / denom) * 100 : null };
  }, [statusRows]);

  const consumptionAgg = React.useMemo(() => {
    const last = consumptionRows.length ? consumptionRows[consumptionRows.length - 1] : null;
    const currPowerKw = last ? Number((last as any).power || 0) : 0;
    let totalKwh = 0, totalCost = 0, sawCost = false;
    for (const r of consumptionRows) {
      totalKwh += Number((r as any).consumption_total || 0);
      const c = (r as any).cost;
      if (c != null) { sawCost = true; totalCost += Number(c); }
    }
    return { currPowerKw, totalKwh, totalCost, sawCost };
  }, [consumptionRows]);

  const prodAgg = React.useMemo(() => {
    if (facet !== 'productivity') {
      return {
        oee: null, availability: null, performance: null, quality: null,
        cycles: 0, good: 0, bad: 0, avgCycleTime: null as number | null,
        avgCycleCost: null as number | null
      };
    }
    let oeeSum=0, aSum=0, pSum=0, qSum=0, nO=0, nA=0, nP=0, nQ=0;
    let cycles=0, good=0, bad=0, actSum=0, nAct=0, accSum=0, nAcc=0;
    for (const r of prodRows) {
      const rr = r as any;
      if (rr.oee != null)          { oeeSum += Number(rr.oee); nO++; }
      if (rr.availability != null) { aSum  += Number(rr.availability); nA++; }
      if (rr.performance != null)  { pSum  += Number(rr.performance); nP++; }
      if (rr.quality != null)      { qSum  += Number(rr.quality); nQ++; }
      if (rr.cycles != null)       cycles += Number(rr.cycles);
      if (rr.good_cycles != null)  good   += Number(rr.good_cycles);
      if (rr.bad_cycles != null)   bad    += Number(rr.bad_cycles);
      if (rr.avg_cycle_time != null) { actSum += Number(rr.avg_cycle_time); nAct++; }
      if (rr.avg_cycle_cost != null) { accSum += Number(rr.avg_cycle_cost); nAcc++; }
    }
    return {
      oee: nO ? oeeSum / nO : null,
      availability: nA ? aSum / nA : null,
      performance: nP ? pSum / nP : null,
      quality: nQ ? qSum / nQ : null,
      cycles, good, bad,
      avgCycleTime: nAct ? actSum / nAct : null,
      avgCycleCost: nAcc ? accSum / nAcc : null,
    };
  }, [facet, prodRows]);

  const eur = React.useMemo(
    () => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    []
  );
  const avgCycleTime = prodAgg.avgCycleTime; 
  const avgCycleCost = prodAgg.avgCycleCost;

  const anyLoading = (facet === 'productivity')
    ? (statusLoading || consLoading)
    : (facet === 'status' ? consLoading : statusLoading);

  if (!open) return null;

  return (
    <Box
      sx={{
        position: 'fixed',
        top, left, width, height,
        zIndex: theme.zIndex.appBar + 3, // above dashboard content, below true modals
        pointerEvents: 'auto',
      }}
      aria-label="Machine details overlay"
      data-areaid="machine-overlay-panel"
      data-eid={`machine-overlay.${facet}`}
    >
      <Paper
        elevation={6}
        sx={{
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          bgcolor: 'background.default',
          border: t => `1px solid ${t.palette.divider}`,
          borderRadius: 2,
          overflow: 'hidden',
        }}
      >
        <AppBar position="sticky" color="default" elevation={1}
          sx={{ top: 0, borderBottom: t => `1px solid ${t.palette.divider}` }}>
          <Toolbar variant="dense" sx={{ gap: 2 }}>
            <Typography variant="subtitle2" color="text.secondary">
              {facet === 'productivity' ? 'Productivity' : 'Machine'}
            </Typography>
            <Typography
              variant="h6"
              sx={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              title={name}
            >
              {name}
            </Typography>
            <IconButton edge="end" onClick={onClose} aria-label="Close overlay">
              <CloseIcon />
            </IconButton>
          </Toolbar>
        </AppBar>

        {/* BODY */}
        <Box sx={{ p: 2, overflow: 'auto', flex: 1 }}>
          {/* ===== PRODUCTIVITY CASE ===== */}
          {facet === 'productivity' && (
            <>
              <Box data-areaid="dash.overlay.metrics" data-eid="dash.overlay.metrics">
                <Grid container spacing={2}>
                  <Grid item xs={12} md={6} lg={4}>
                    <OeeSummaryTile
                      oee={prodAgg.oee}
                      availability={prodAgg.availability}
                      performance={prodAgg.performance}
                      quality={prodAgg.quality}
                    />
                  </Grid>
                  <Grid item xs={12} md={6} lg={4}>
                    <CyclesTile
                      cycles={prodAgg.cycles}
                      goodCycles={prodAgg.good}
                      badCycles={prodAgg.bad}
                    />
                  </Grid>
                  <Grid item xs={12} md={6} lg={4}>
                    <Card sx={{ height: '100%' }}>
                      <CardContent sx={{ pt: 1.5 }}>
                        <Typography variant="caption">Consumption &amp; Cost</Typography>

                        {/* Row 1 — kWh total (full width) */}
                        <Grid container spacing={2}>
                          <Grid item xs={12} sm={6}>
                            <Typography variant="h5">
                              {Math.round(consumptionAgg.totalKwh).toLocaleString('en-GB')} kWh
                            </Typography>
                            <Typography variant="body2" color="text.secondary">Total consumption</Typography>
                          </Grid>
                          <Grid item xs={12} sm={6}>
                            <Stack spacing={0.5}>
                              <Typography variant="h5">{eur.format(consumptionAgg.totalCost)}</Typography>
                              <Typography variant="body2" color="text.secondary">Total cost</Typography>
                            </Stack>
                          </Grid>
                        </Grid>

                        {/* Horizontal divider between rows */}
                        <Divider sx={{ my: 1.5 }} />

                        {/* Row 2 — total € and average cycle time */}
                        <Grid container spacing={2}>
                          <Grid item xs={12} sm={6}>
                            <Stack spacing={0.5}>
                              <Typography variant="h5">
                                {avgCycleTime == null ? '—' : `${avgCycleTime.toFixed(2)} s`}
                              </Typography>
                              <Typography variant="body2" color="text.secondary">Average cycle time</Typography>
                            </Stack>
                          </Grid>
                          <Grid item xs={12} sm={6}>
                            <Stack spacing={0.5}>
                              <Typography variant="h5">
                                {avgCycleCost == null ? '—' : `${avgCycleCost.toFixed(3)} €`}
                              </Typography>
                              <Typography variant="body2" color="text.secondary">Average cycle cost</Typography>
                            </Stack>
                          </Grid>
                        </Grid>
                      </CardContent>
                    </Card>
                  </Grid>
                </Grid>
              </Box>

              {anyLoading && (
                <Stack direction="row" alignItems="center" spacing={1} sx={{ mt: 1 }}>
                  <CircularProgress size={16} />
                  <Typography variant="body2" color="text.secondary">Loading additional metrics…</Typography>
                </Stack>
              )}

              <Box sx={{ height: 20 }} />
              <TrendChart variant="oee" data={prodRows} serverStepMin={serverStepMin} avgExcludeZeros showAverageLine data-areaid="dash.overlay.chart.oee" data-eid="dash.overlay.chart.oee" />
              <Box sx={{ height: 20 }} />
              <TrendChart variant="cycles" data={prodRows} serverStepMin={serverStepMin} unitOverride="cycles" avgExcludeZeros showAverageLine  data-areaid="dash.overlay.chart.cycles" data-eid="dash.overlay.chart.cycles"/>
              <Box sx={{ height: 20 }} />
              <TrendChart variant="consumption" data={consumptionRows} serverStepMin={serverStepMin} showAverageLine data-areaid="dash.overlay.chart.consumption" data-eid="dash.overlay.chart.consumption" />
              <Box sx={{ height: 20 }} />

              {/* Status timeline for context */}
              <Box sx={{ mb: 3 }} data-areaid="dash.overlay.utilization_row" data-eid="dash.overlay.utilization_row">
                <Typography variant="subtitle1" sx={{ mb: 1 }}>Machine status</Typography>
                <MachineUtilizationRow
                  machineType="Production machine"
                  statusRows={statusRows}
                  from={from}
                  to={to}
                  rowBucketMinutes={serverStepMin}
                  now={new Date(scenarioAnchorUtc)}
                  displayTz={scenarioTz}
                  snapStartToMidnight={false}
                  snapEndToEndOfDay={false}
                  respectNow={false}  
                  respectLastData={false}
                />
              </Box>
            </>
          )}

          {/* ===== STATUS or CONSUMPTION CASE: show both sections together ===== */}
          {(facet === 'status' || facet === 'consumption') && (
            <>
              <Box data-areaid="dash.overlay.metrics" data-eid="dash.overlay.metrics">
                <Grid container spacing={2}>
                  <Grid item xs={12} md={3}>
                    <Card><CardContent>
                      <Typography variant="caption">Utilization</Typography>
                      <Typography variant="h5">{statusAgg.utilPct == null ? '—' : `${statusAgg.utilPct.toFixed(1)} %`}</Typography>
                    </CardContent></Card>
                  </Grid>
                  <Grid item xs={12} md={3}>
                    <Card><CardContent>
                      <Typography variant="caption">Working time</Typography>
                      <Typography variant="h5">{fmtHHMMSS(statusAgg.working)}</Typography>
                    </CardContent></Card>
                  </Grid>
                  <Grid item xs={12} md={3}>
                    <Card><CardContent>
                      <Typography variant="caption">Idle time</Typography>
                      <Typography variant="h5">{fmtHHMMSS(statusAgg.idle)}</Typography>
                    </CardContent></Card>
                  </Grid>
                  <Grid item xs={12} md={3}>
                    <Card><CardContent>
                      <Typography variant="caption">Alarm time</Typography>
                      <Typography variant="h5">{fmtHHMMSS(statusAgg.alarm)}</Typography>
                    </CardContent></Card>
                  </Grid>

                  <Grid item xs={12} md={3}>
                    <Card><CardContent>
                      <Typography variant="caption">Current power</Typography>
                      <Typography variant="h5">{consumptionAgg.currPowerKw.toFixed(1)} kW</Typography>
                    </CardContent></Card>
                  </Grid>
                  <Grid item xs={12} md={3}>
                    <Card><CardContent>
                      <Typography variant="caption">Total consumption</Typography>
                      <Typography variant="h5">{consumptionAgg.totalKwh.toFixed(0)} kWh</Typography>
                    </CardContent></Card>
                  </Grid>
                  <Grid item xs={12} md={3}>
                    <Card><CardContent>
                      <Typography variant="caption">Total costs</Typography>
                      <Typography variant="h5">{consumptionAgg.sawCost ? `€${consumptionAgg.totalCost.toFixed(2)}` : '—'}</Typography>
                    </CardContent></Card>
                  </Grid>
                </Grid>
              </Box>

              {anyLoading && (
                <Stack direction="row" alignItems="center" spacing={1} sx={{ mt: 1 }}>
                  <CircularProgress size={16} />
                  <Typography variant="body2" color="text.secondary">Loading additional metrics…</Typography>
                </Stack>
              )}

              <Box sx={{ height: 20 }} />

              {/* Status timeline */}
              <Box sx={{ mb: 3 }} data-areaid="dash.overlay.utilization_row" data-eid="dash.overlay.utilization_row">
                <Typography variant="subtitle1" sx={{ mb: 1 }}>Machine status</Typography>
                <MachineUtilizationRow
                  machineType="Production machine"
                  statusRows={statusRows}
                  from={from}
                  to={to}
                  rowBucketMinutes={serverStepMin}
                  snapStartToMidnight={false}
                  snapEndToEndOfDay={false}
                  respectNow={false}
                  respectLastData={false}
                />
              </Box>

              {/* Consumption charts */}
              <Box>
                <Typography variant="subtitle1" sx={{ mb: 1 }}>Consumption</Typography>
                <TrendChart variant="consumption" data={consumptionRows} serverStepMin={serverStepMin} showAverageLine data-areaid="dash.overlay.chart.consumption" data-eid="dash.overlay.chart.consumption" />
                <Box sx={{ height: 20 }} />
                <TrendChart variant="power" data={consumptionRows} serverStepMin={serverStepMin} showAverageLine smoothing="ewma" data-areaid="dash.overlay.chart.power" data-eid="dash.overlay.chart.power" />
              </Box>
            </>
          )}
        </Box>
      </Paper>
    </Box>
  );
}
