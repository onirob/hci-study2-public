import React, { useMemo } from 'react';
import { Card, Box, Typography } from '@mui/material';
import { useTheme, alpha } from '@mui/material/styles';
import {
  ComposedChart, Bar, Line, Area, XAxis, YAxis, Tooltip, CartesianGrid,
  ResponsiveContainer, Legend, ReferenceLine,
} from 'recharts';

type Variant = 'power' | 'consumption' | 'oee' | 'cycles';

export type TrendRow = {
  t: string;
  prod?: number;
  aux?: number;
  total?: number;
  oee?: number;
  good?: number;
  bad?: number;
};

type TrendCardProps = {
  data: any[];
  variant: Variant;
  title?: string;
  height?: number;
  unitOverride?: string;
  smoothing?: 'ewma' | 'movavg' | 'none';
  ewmaAlpha?: number;
  maWindow?: number;
  powerBarSize?: number;
  showAverageLine?: boolean;
  avgExcludeZeros?: boolean;
  serverStepMin?: number;
  targetBars?: number;
};

function ewma(values: number[], alphaV = 0.25) {
  const out: number[] = [];
  let prev = values[0] ?? 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i] ?? 0;
    prev = alphaV * v + (1 - alphaV) * prev;
    out.push(prev);
  }
  return out;
}
function movingAvg(values: number[], window = 8) {
  const out: number[] = [];
  let acc = 0; const q: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const val = values[i] ?? 0;
    q.push(val); acc += val;
    if (q.length > window) acc -= q.shift()!;
    out.push(acc / q.length);
  }
  return out;
}

function capTrendRowsForRender(
  rows: any[],
  maxBars: number,
  variant: Variant,
  smoothing: 'ewma' | 'movavg' | 'none',
  ewmaAlpha: number,
  maWindow: number
) {
  if (!rows || rows.length <= maxBars) return rows;

  const k = Math.ceil(rows.length / maxBars); // group size
  const out: any[] = [];

  for (let i = 0; i < rows.length; i += k) {
    const group = rows.slice(i, i + k);
    const first = group[0];
    const agg: any = {
      // keep time anchors from first item in the group
      t: first.t,
      tMs: first.tMs,
      // widen step for tooltips/padding (only for display)
      __stepMin: (first.__stepMin ?? 15) * k,
      __spanMin: first.__spanMin,
    };

    if (variant === 'consumption') {
      agg.prod  = group.reduce((a: number, g: any) => a + (g.prod ?? 0), 0);
      agg.aux   = group.reduce((a: number, g: any) => a + (g.aux ?? 0), 0);
      agg.total = agg.prod + agg.aux;
    } else if (variant === 'cycles') {
      agg.good = group.reduce((a: number, g: any) => a + (g.good ?? 0), 0);
      agg.bad  = group.reduce((a: number, g: any) => a + (g.bad  ?? 0), 0);
      agg.totalCycles = (agg.good ?? 0) + (agg.bad ?? 0);
    } else if (variant === 'oee') {
      const vals = group.map((g: any) => g.oeeDisplay ?? 0);
      const n = vals.length || 1;
      agg.oeeDisplay = vals.reduce((a, b) => a + b, 0) / n; // average
    } else { // 'power'
      const vals = group.map((g: any) => g.total ?? 0);
      const n = vals.length || 1;
      agg.total = vals.reduce((a, b) => a + b, 0) / n; // average power
    }

    out.push(agg);
  }

  // Recompute trend after capping (power only)
  if (variant === 'power') {
    const vals = out.map(d => d.total ?? 0);
    const trend =
      smoothing === 'ewma'   ? ewma(vals, ewmaAlpha) :
      smoothing === 'movavg' ? movingAvg(vals, maWindow) :
                               vals.slice();
    out.forEach((d, i) => (d.trend = trend[i]));
  }

  return out;
}

const parseT = (t: string): Date | null => {
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d;
};
const floorToStep = (d: Date, stepMin: number) => {
  const x = new Date(d);
  x.setSeconds(0, 0);
  const m = x.getMinutes();
  x.setMinutes(m - (m % stepMin));
  return x;
};

function pickStepMinutes(
  from: Date,
  to: Date,
  targetBars = 48,
  allowed: number[] = [15, 30, 60, 90]
) {
  const totalMin = Math.max(1, Math.floor((to.getTime() - from.getTime()) / 60000));
  const needed = Math.ceil(totalMin / targetBars);
  for (const s of allowed) if (s >= needed) return s;
  return allowed[allowed.length - 1];
}

function aggregateTrend(
  rows: TrendRow[],
  stepMin: number,
  variant: Variant
): TrendRow[] {
  const buckets = new Map<number, { t: Date; prod: number; aux: number; total: number; n: number }>();

  for (const r of rows) {
    const dt = parseT(r.t);
    if (!dt) continue;
    const t0 = floorToStep(dt, stepMin);
    const k = t0.getTime();

    let b = buckets.get(k);
    if (!b) { b = { t: t0, prod: 0, aux: 0, total: 0, n: 0 }; buckets.set(k, b); }

    const prod = r.prod ?? 0;
    const aux  = r.aux  ?? 0;
    const total = r.total ?? (prod + aux);

    if (variant === 'consumption') {
      b.prod  += prod;
      b.aux   += aux;
      b.total += total;
    } else if (variant === 'power') {
      b.prod  += prod;
      b.aux   += aux;
      b.total += total;
      b.n++;
    } else {
      b.total += total;
      b.n++;
    }
  }

  const out = Array.from(buckets.values()).sort((a, b) => a.t.getTime() - b.t.getTime());

  if (variant === 'power') {
    out.forEach(b => {
      const n = b.n || 1;
      b.prod  = b.prod / n;
      b.aux   = b.aux  / n;
      b.total = b.total / n;
    });
  }

  return out.map(b => ({
    t: new Date(b.t.getTime()).toISOString(),
    prod: b.prod,
    aux: b.aux,
    total: b.total,
  }));
}

function aggregateOee(rows: { t: string; oee?: number }[], stepMin: number) {
  const m = new Map<number, { t: Date; sum: number; n: number }>();
  for (const r of rows) {
    const d = parseT(r.t); if (!d) continue;
    const k = floorToStep(d, stepMin).getTime();
    const b = m.get(k) ?? { t: new Date(k), sum: 0, n: 0 };
    if (r.oee != null) { b.sum += Number(r.oee); b.n += 1; }
    m.set(k, b);
  }
  return Array.from(m.values())
    .sort((a, b) => a.t.getTime() - b.t.getTime())
    .map(b => ({ t: b.t.toISOString(), oee: b.n ? b.sum / b.n : 0 }));
}

function aggregateCycles(rows: { t: string; good?: number; bad?: number }[], stepMin: number) {
  const m = new Map<number, { t: Date; good: number; bad: number }>();
  for (const r of rows) {
    const d = parseT(r.t); if (!d) continue;
    const k = floorToStep(d, stepMin).getTime();
    const b = m.get(k) ?? { t: new Date(k), good: 0, bad: 0 };
    b.good += Number(r.good ?? 0);
    b.bad  += Number(r.bad  ?? 0);
    m.set(k, b);
  }
  return Array.from(m.values())
    .sort((a, b) => a.t.getTime() - b.t.getTime())
    .map(b => ({ t: b.t.toISOString(), good: b.good, bad: b.bad }));
}

function mapApiToTrendRows(rows: any[], variant: Variant): TrendRow[] {
  const looksApi = rows.length && 't_bucket' in rows[0];
  if (!looksApi) return rows as TrendRow[];

  const byT = new Map<string, any>();

  for (const r of rows as any[]) {
    const t = r.t_bucket;
    if (!t) continue;
    let g = byT.get(t);
    if (!g) {
      g = { prod: 0, aux: 0, total: 0, oeeSum: 0, oeeN: 0, good: 0, bad: 0 };
      byT.set(t, g);
    }

    if (variant === 'power') {
      g.total += Number(r.power ?? 0);
    } else if (variant === 'consumption') {
      const w = Number(r.consumption_working ?? 0);
      const i = Number(r.consumption_idle ?? 0);
      const tot = Number(r.consumption_total ?? 0);
      g.prod  += w;
      g.aux   += i;
      g.total += tot;
    } else if (variant === 'oee') {
      const o = r.oee;
      if (o != null) { g.oeeSum += Number(o); g.oeeN += 1; }
    } else if (variant === 'cycles') {
      g.good += Number(r.good_cycles ?? 0);
      g.bad  += Number(r.bad_cycles ?? 0);
    }
  }

  return Array.from(byT.entries())
    .sort((a, b) => new Date(a[0]).getTime() - new Date(b[0]).getTime())
    .map(([t, g]) => {
      if (variant === 'oee') {
        const avgOee = g.oeeN ? g.oeeSum / g.oeeN : 0;
        return { t, oee: avgOee };
      }
      if (variant === 'cycles') {
        return { t, good: g.good, bad: g.bad };
      }
      return { t, prod: g.prod, aux: g.aux, total: g.total };
    });
}

const useAxisStyles = (axisColor: string, gridColor: string) =>
  useMemo(() => ({
    xTick: { fill: axisColor, fontSize: 12 } as const,
    yTick: { fill: axisColor, fontSize: 12 } as const,
    xAxisLine: { stroke: gridColor } as const,
    yAxisLine: { stroke: gridColor } as const,
  }), [axisColor, gridColor]);

export default React.memo(function TrendChart({
  data, variant, title, height = 280, unitOverride,
  smoothing = 'ewma', ewmaAlpha = 0.25, maWindow = 8, powerBarSize = 6,
  showAverageLine = false, avgExcludeZeros = false, serverStepMin,
  targetBars = 48,
}: TrendCardProps) {
  const theme = useTheme();
  const nf2 = useMemo(() => new Intl.NumberFormat('en-EN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }), []);
  const nf0 = useMemo(() => new Intl.NumberFormat('en-EN', { maximumFractionDigits: 0 }), []);

  const prepared = useMemo(() => {
    const mapped = mapApiToTrendRows(data, variant);
    if (!mapped.length) return [];

    const validDs = mapped.map(d => parseT(d.t)).filter((x): x is Date => !!x);
    const first = validDs[0]!;
    const last  = validDs[validDs.length - 1]!;
    const spanMin = Math.max(1, Math.floor((last.getTime() - first.getTime()) / 60000));
    const stepMin = serverStepMin ?? pickStepMinutes(first, last, targetBars);


    let rows: any[] = [];
    if (variant === 'power' || variant === 'consumption') {
      const aggregated = serverStepMin ? mapped : aggregateTrend(mapped, stepMin, variant);
      if (variant === 'power') {
        const vals = aggregated.map(d => d.total ?? 0);
        const trend = smoothing === 'ewma'
          ? ewma(vals, ewmaAlpha)
          : smoothing === 'movavg'
            ? movingAvg(vals, maWindow)
            : vals.slice();
        rows = aggregated.map((d, i) => ({ ...d, trend: trend[i] }));
      } else {
        rows = aggregated;
      }
    } else if (variant === 'oee') {
      rows = serverStepMin ? mapped : aggregateOee(mapped as any, stepMin);
      rows = rows.map((d: any) => ({ ...d, oeeDisplay: d.oee ?? 0 }));
    } else {
      rows = serverStepMin ? mapped : aggregateCycles(mapped as any, stepMin);
      rows = rows.map((d: any) => ({ ...d, totalCycles: (d.good ?? 0) + (d.bad ?? 0) }));
    }

    return rows.map((d: any) => ({
      ...d,
      tMs: Date.parse(d.t),
      __spanMin: spanMin,
      __stepMin: stepMin,
    }));
  }, [data, variant, smoothing, ewmaAlpha, maWindow, serverStepMin, targetBars]);

  // Cap the number of rendered points to targetBars (visual only)
  const displayData = useMemo(
    () => capTrendRowsForRender(prepared, targetBars, variant, smoothing, ewmaAlpha, maWindow),
    [prepared, targetBars, variant, smoothing, ewmaAlpha, maWindow]
  );

  const spanMin = (prepared[0] as any)?.__spanMin ?? 0;
  const stepMin = (prepared[0] as any)?.__stepMin ?? 15;
  

  const xTicks = useMemo(() => {
    const N = displayData.length;
    if (!N) return [];
    const wanted = 7;
    const stride = Math.max(1, Math.ceil(N / wanted));
    const arr: number[] = [];
    for (let i = 0; i < N; i += stride) arr.push(displayData[i].tMs);
    if (arr[arr.length - 1] !== displayData[N - 1].tMs) arr.push(displayData[N - 1].tMs);
    return arr;
  }, [displayData]);

  const units = unitOverride ?? (
    variant === 'oee' ? '%' :
    variant === 'power' ? 'kW' :
    variant === 'consumption' ? 'kWh' : 'cycles'
  );

  const avgValue = useMemo(() => {
    const values: number[] =
      variant === 'power'       ? prepared.map((d: any) => d.total ?? 0) :
      variant === 'consumption' ? prepared.map((d: any) => (d.total ?? ((d.prod ?? 0) + (d.aux ?? 0)))) :
      variant === 'oee'         ? prepared.map((d: any) => d.oeeDisplay ?? 0) :
                                  prepared.map((d: any) => d.totalCycles ?? ((d.good ?? 0) + (d.bad ?? 0)));
    const nums = avgExcludeZeros ? values.filter(v => v !== 0) : values;
    if (nums.length === 0) return 0;
    return nums.reduce((a, b) => a + b, 0) / nums.length;
  }, [prepared, variant, avgExcludeZeros]);

  // ---- Colors (unchanged) ----
  const axisColor = alpha('#FFFFFF', 0.6);
  const gridColor = alpha('#FFFFFF', 0.12);
  const avgColor = alpha('#FFFFFF', 0.5);
  const barGrey = alpha('#FFFFFF', 0.35);
  const lineBlue = theme.palette.info.light;
  const barBlue = '#42a5f5';
  const barYellow = '#fbc02d';
  const barGreen = theme.palette.success.main;
  const barRed = theme.palette.error.main;

  const { xTick, yTick, xAxisLine, yAxisLine } = useAxisStyles(axisColor, gridColor);

  const fmt = (v: number) => {
    if (units === '%')  return `${nf0.format(v)}%`;
    if (units === 'kWh' || units === 'kW') return `${nf2.format(v)} ${units}`; // always 2dp
    return nf0.format(v);
  };

  const effStepMin = (displayData[0] as any)?.__stepMin ?? stepMin;
  const padMs = useMemo(() => Math.max(1, Math.round((effStepMin ?? 15) * 60000 / 2)), [effStepMin]);


  const xDomain = useMemo(() => {
    if (!displayData.length) return ['dataMin', 'dataMax'] as const;
    const left  = displayData[0].tMs - padMs;
    const right = displayData[displayData.length - 1].tMs + padMs;
    return [left, right] as const;
  }, [displayData, padMs]);


  const yDomain: [number, number | ((max: number) => number)] = [0, (max: number) => Math.max(1, max * 1.1)];
  const computedTitle =
    title ?? (variant === 'power' ? 'Power trend' :
              variant === 'consumption' ? 'Consumption trend' :
              variant === 'oee' ? 'OEE trend' : 'Cycles trend');

  const xTickFmt = useMemo(() => {
    if (spanMin <= 36 * 60) {
      const f = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: true });
      return (ms: number) => f.format(new Date(ms));
    }
    if (effStepMin  < 1440) {
      const f = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: '2-digit' });
      return (ms: number) => f.format(new Date(ms)).replace(',', '');
    }
    const f = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
    return (ms: number) => f.format(new Date(ms));
  }, [spanMin, effStepMin ]);

  const formatTooltipLabel = useMemo(() => {
    const partsOf = (d: Date, opts: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat('en-GB', opts).formatToParts(d);
    const pick = (ps: Intl.DateTimeFormatPart[], t: string) =>
      ps.find(p => p.type === t)?.value ?? '';

    const fmtDayMon = (d: Date) => {
      const ps = partsOf(d, { day: '2-digit', month: 'short' });
      return `${pick(ps, 'day')} ${pick(ps, 'month')}`;
    };

    const fmtTime12 = (d: Date) => {
      const ps = partsOf(d, { hour: '2-digit', minute: '2-digit', hour12: true });
      const dp = pick(ps, 'dayPeriod') || pick(ps, 'dayperiod') || '';
      return `${pick(ps, 'hour')}:${pick(ps, 'minute')} ${dp}`.trim();
    };

    const fmtDateTime12 = (d: Date) => `${fmtDayMon(d)}, ${fmtTime12(d)}`;

    if (spanMin <= 24 * 60) {
      return (ms: number) => {
        const start = new Date(ms);
        const end   = new Date(ms + effStepMin * 60000);
        return `${fmtDayMon(start)}, ${fmtTime12(start)} - ${fmtTime12(end)}`;
      };
    }

    if (effStepMin < 1440) {
      return (ms: number) => fmtDateTime12(new Date(ms));
    }

    return (ms: number) => {
      const ps = partsOf(new Date(ms), { day: '2-digit', month: 'short', year: 'numeric' });
      return `${pick(ps, 'day')} ${pick(ps, 'month')} ${pick(ps, 'year')}`;
    };
  }, [spanMin, effStepMin]);


  // Tooltip content (consumption shows Idle → Working → Total)
  const TooltipContent = useMemo(() => {
    return function TooltipContentInner({ active, payload, label }: any) {
      if (!active || !payload?.length) return null;

      const prettyLabel = formatTooltipLabel(label as number);
      const base = (payload[0] as any)?.payload ?? {};

      // Filter out 'trend' for power
      let rows = (payload as any[]).filter(p => !(variant === 'power' && p.dataKey === 'trend'));

      // Reorder + add "Total" for consumption
      if (variant === 'consumption') {
        const auxItem  = rows.find(r => r.dataKey === 'aux');
        const prodItem = rows.find(r => r.dataKey === 'prod');
        rows = [auxItem, prodItem].filter(Boolean) as any[];
      }

      const totalForConsumption =
        variant === 'consumption'
          ? (base.total ?? ((base.prod ?? 0) + (base.aux ?? 0)))
          : null;

      return (
        <div
          style={{
            background: 'rgba(20,20,20,0.95)',
            border: '1px solid rgba(255,255,255,0.2)',
            borderRadius: 8,
            padding: '8px 10px',
            color: '#fff',
            minWidth: 200
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 6 }}>{prettyLabel}</div>

          {rows.map((p, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', margin: '2px 0' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 10, height: 10, background: p.color, borderRadius: 2, display: 'inline-block' }} />
                <span style={{ opacity: 0.9 }}>
                  {p.name ?? (p.dataKey === 'total' ? 'Total power' : p.dataKey)}
                </span>
              </div>
              <div style={{ opacity: 0.9 }}>
                {fmt(p.value)}
              </div>
            </div>
          ))}

          {variant === 'consumption' && (
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', margin: '6px 0 2px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 10, height: 10, background: barGrey, borderRadius: 2, display: 'inline-block' }} />
                <span style={{ opacity: 0.9 }}>Total energy</span>
              </div>
              <div style={{ opacity: 0.9 }}>
                {fmt(totalForConsumption ?? 0)}
              </div>
            </div>
          )}

          <div style={{ borderTop: '1px solid rgba(255,255,255,0.15)', margin: '6px 0 0' }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontWeight: 600 }}>
            <span>Average</span>
            <span>{fmt(avgValue)}</span>
          </div>
        </div>
      );
    };
  }, [avgValue, variant, formatTooltipLabel, barGrey]);

  const useAreas =
    (variant === 'power' && prepared.length > 100);

  return (
    <Card sx={{ p: 2, width: '100%' }}>
      <Typography variant="subtitle2">{computedTitle}</Typography>
      <Box sx={{ mt: 1, height, width: '100%', minWidth: 0 }}>
        <ResponsiveContainer width="100%" height="100%" debounce={100}>
          {/* add left margin to keep Y label outside without overlap; right margin for label safety */}
          <ComposedChart data={displayData} margin={{ top: 8, right: 24, left: 28, bottom: 8 }}>
            <CartesianGrid stroke={gridColor} strokeDasharray="3 3" vertical={false} />
            <XAxis
              type="number"
              dataKey="tMs"
              ticks={xTicks}
              tick={xTick}
              tickFormatter={xTickFmt}
              interval={0}
              tickMargin={6}
              tickLine={false}
              axisLine={xAxisLine}
              domain={xDomain as any}
            />
            <YAxis
              tick={yTick}
              width={46}
              domain={yDomain}
              tickFormatter={(v) => (units === '%' ? `${nf0.format(v)}` : nf2.format(v))}
              // move label outside to avoid overlap
              label={{ value: units, angle: -90, position: 'left', fill: axisColor }}
              tickLine={false}
              axisLine={yAxisLine}
            />

            <Tooltip content={TooltipContent as any} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />

            {showAverageLine && (
              <ReferenceLine
                y={avgValue}
                stroke={avgColor}
                strokeDasharray="6 6"
                isFront
                ifOverflow="extendDomain"
                label={{ value: 'Avg', position: 'insideRight', fill: axisColor, fontSize: 12 }}
              />
            )}

            {/* POWER */}
            {variant === 'power' && (
              useAreas ? (
                <Area
                  type="monotone"
                  dataKey="trend"
                  stroke={lineBlue}
                  fillOpacity={0}
                  dot={false}
                  isAnimationActive={false}
                />
              ) : (
                <>
                  <Bar
                    dataKey="total"
                    fill={barGrey}
                    barSize={powerBarSize}
                    maxBarSize={powerBarSize}
                    radius={[2, 2, 0, 0]}
                    isAnimationActive={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="trend"
                    stroke={lineBlue}
                    dot={false}
                    strokeWidth={2}
                    isAnimationActive={false}
                  />
                </>
              )
            )}

            {/* CONSUMPTION (stacked BARS only) */}
            {variant === 'consumption' && (
              <>
                <Bar
                  dataKey="prod"
                  name="Working energy"
                  fill={barBlue}
                  barSize={16}             // match cycles’ visual weight; change if you prefer
                  stackId="c"
                  radius={[4, 4, 0, 0]}
                  isAnimationActive={false}
                />
                <Bar
                  dataKey="aux"
                  name="Idle energy"
                  fill={barYellow}
                  barSize={16}
                  stackId="c"
                  isAnimationActive={false}
                />
                <Legend verticalAlign="bottom" iconType="circle" />
              </>
            )}

            {/* OEE */}
            {variant === 'oee' && (
              <>
                <Bar dataKey="oeeDisplay" name="OEE" fill={barBlue} barSize={16} radius={[4, 4, 0, 0]} isAnimationActive={false} />
                <Legend verticalAlign="bottom" iconType="circle" />
              </>
            )}

            {/* CYCLES */}
            {variant === 'cycles' && (
              <>
                <Bar dataKey="good" name="Good" fill={barGreen} barSize={16} stackId="cycles" radius={[4, 4, 0, 0]} isAnimationActive={false} />
                <Bar dataKey="bad"  name="Bad"  fill={barRed}   barSize={16} stackId="cycles" isAnimationActive={false} />
                <Legend verticalAlign="bottom" iconType="circle" />
              </>
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </Box>
    </Card>
  );
});
