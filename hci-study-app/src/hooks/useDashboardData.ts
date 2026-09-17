import { useEffect, useMemo, useRef, useState } from 'react';

// Backend facets
export type Facet = 'power' | 'consumption' | 'status' | 'productivity';


// ---- Row shapes returned by the API ----
type BaseRow = {
  machine_id: string;
  machine_name: string;   
  t_bucket: string;       // ISO timestamp
};

// consumption / power
export type ConsumptionRow = BaseRow & {
  power: number | null;             // avg power (kW)
  consumption_total: number | null; // delta per bucket (kWh)
  consumption_working: number | null;
  consumption_idle: number | null;
  cost: number | null;              // EUR
};

// status
export type StatusRow = BaseRow & {
  working_time: number | null;      // seconds
  idle_time: number | null;         // seconds
  offline_time: number | null;      // seconds
  alarm_time: number | null;        // seconds
  alarm_start_count: number | null;
  utilization_rate?: number | null; 
};

// productivity
export type ProductivityRow = BaseRow & {
  cycles: number | null;
  good_cycles: number | null;
  bad_cycles: number | null;
  oee: number | null;               // %
  quality: number | null;           // %
  performance: number | null;       // %
  availability: number | null;      // %
  avg_cycle_time: number | null;    // seconds
  avg_cycle_cost: number | null;    // EUR
  cost: number | null;              // EUR
};

export type AnyRow = ConsumptionRow | StatusRow | ProductivityRow;

export type TimeseriesResponse<T = AnyRow> = {
  series: T[];
  bucket?: string;
};

export function pickAdaptiveBucket(
  from: Date,
  to: Date,
  targetBars = 72,
  opts?: { minStepMin?: number }     // allow a floor, default 15
): string {
  const minStep = opts?.minStepMin ?? 15;
  const totalMin = Math.max(1, Math.floor((to.getTime() - from.getTime()) / 60000));

  // RULE: for day-or-less ranges, always use 15m (denser daily view)
  if (totalMin <= 1440) return `${minStep}m`;

  // otherwise pick a step aiming for ~targetBars and snap to a grid
  const desired = Math.max(minStep, Math.ceil(totalMin / targetBars));
  const grid = [15, 30, 60, 120, 240, 360, 720, 1440];   // minutes
  const picked = grid.find(g => g >= desired) ?? grid[grid.length - 1];

  return picked >= 60 ? `${Math.round(picked / 60)}h` : `${picked}m`;
}

export type Params = {
  from: Date;
  to: Date;
  facet: Facet;
  bucket?: string;         // optional; if omitted we pick adaptively
  machineIds?: string[];
  targetBars?: number;     // <-- optional, default 72
};

const toIsoSeconds = (d: Date) => d.toISOString().slice(0, 19) + 'Z';


const parseBucketToMinutes = (b?: string): number | undefined => {
  if (!b) return;
  const s = b.trim().toLowerCase();
  if (s === 'day' || s === '1 day') return 1440;
  if (s.endsWith('h')) return Math.max(1, parseInt(s, 10) * 60);
  if (s.endsWith('m')) return Math.max(1, parseInt(s, 10));
  if (s.includes('hour'))   return Math.max(1, parseInt(s, 10) * 60);
  if (s.includes('minute')) return Math.max(1, parseInt(s, 10));
};
export { parseBucketToMinutes }; 

export function useDashboardData(params: Params) {
  const [data, setData] = useState<TimeseriesResponse<AnyRow> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const qs = useMemo(() => {

    const p = new URLSearchParams();
    p.set('from_iso', toIsoSeconds(params.from));
    p.set('to_iso',   toIsoSeconds(params.to));
    p.set('facet', params.facet);

    const bucket = params.bucket ?? pickAdaptiveBucket(params.from, params.to, params.targetBars ?? 72);
    p.set('bucket', bucket);
    p.set('tz', 'Europe/Rome');

    if (params.machineIds?.length) p.set('machine_ids', params.machineIds.slice().sort().join(','));
    return p.toString();
  }, [
    params.from.getTime(),
    params.to.getTime(),
    params.facet,
    params.bucket ?? '',
    params.targetBars ?? 72,
    JSON.stringify((params.machineIds ?? []).slice().sort()),
  ]);

  useEffect(() => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setError(null);

    fetch(`/api/dashboard?${qs}`, { signal: ctrl.signal, headers: { Accept: 'application/json' } })
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.text().catch(() => '');
          throw new Error(`Dashboard ${r.status}${body ? `: ${body}` : ''}`);
        }
        return r.json() as Promise<TimeseriesResponse<AnyRow>>;
      })
      .then((j) => setData(j))
      .catch((e) => { if ((e as any).name !== 'AbortError') setError(e as Error); })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });

    return () => ctrl.abort();
  }, [qs, params.bucket]);

  return { data, loading, error };
}
