export type WithTs<T = any> = T & { ts: number };

// Attach a canonical `ts` (ms) field based on common keys
export const addTs = <T extends Record<string, any>>(
  rows: T[],
  candidates: string[] = ['ts', 't', 'time', 'timestamp', 'date']
): WithTs<T>[] =>
  rows.map((r) => {
    const key = candidates.find((k) => r[k] !== undefined && r[k] !== null);
    const raw = key ? (r as any)[key] : undefined;
    const ts = typeof raw === 'number' ? raw : new Date(raw).getTime();
    return { ...(r as any), ts } as WithTs<T>;
  });

export const filterByRange = <T extends { ts: number }>(rows: T[], start: number, end: number) =>
  rows.filter((r) => r.ts >= start && r.ts <= end);

export const sum = (rows: any[], key: string) => rows.reduce((acc, r) => acc + (+r[key] || 0), 0);

export const groupBy = <T extends Record<string, any>>(rows: T[], key: string) => {
  const m = new Map<string, T[]>();
  rows.forEach((r) => {
    const k = String(r[key]);
    const arr = m.get(k);
    if (arr) arr.push(r);
    else m.set(k, [r]);
  });
  return m;
};

// Domain examples — adapt to your schema
export const totalsFromSeries = (series: any[]) => ({
  consumption: sum(series, 'consumption'),
  cost: sum(series, 'cost'),
  co2: sum(series, 'co2'),
});

export const byTypeFromSeries = (series: any[]) => {
  const m = groupBy(series, 'type');
  return Array.from(m, ([name, rows]) => ({ name, consumption: sum(rows, 'consumption') }));
};

// Convert 15‑minute samples to hourly/daily, if needed
export const bucket = <T extends { ts: number }>(rows: T[], sizeMs: number, rollup: (rows: T[]) => any) => {
  const buckets = new Map<number, T[]>();
  rows.forEach((r) => {
    const b = Math.floor(r.ts / sizeMs) * sizeMs;
    const arr = buckets.get(b) ?? [];
    arr.push(r);
    buckets.set(b, arr);
  });
  return Array.from(buckets, ([ts, r]) => ({ ts, ...rollup(r) }));
};
