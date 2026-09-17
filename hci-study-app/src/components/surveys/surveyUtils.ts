// LocalStorage keys
export const bdliKey = (cycle?: string) => `survey.bdli.${cycle ?? 'NA'}`;
export const techKey = (cycle?: string) => `survey.techfam.${cycle ?? 'NA'}`;

// BDLI scoring (Likert 1–5 → 0–100, average)
export function computeBdliScore(values: Record<string, number>): number | null {
  const keys = Object.keys(values);
  if (!keys.length) return null;
  const list = keys.map(k => values[k]).filter((x): x is number => typeof x === 'number');
  if (list.length !== keys.length) return null;
  const to0100 = (x: number) => ((x - 1) / 4) * 100;
  const avg = list.map(to0100).reduce((a, b) => a + b, 0) / list.length;
  return Math.round(avg * 10) / 10;
}
