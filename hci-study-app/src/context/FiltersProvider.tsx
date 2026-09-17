import React, { createContext, useContext, useMemo, useState, useCallback } from 'react';
import { startOfDay, endOfDay, isAfter } from 'date-fns';

export type Range = { start: number; end: number }; // ms since epoch (local time)

export type FiltersContextValue = {
  range: Range;                                  // normalized to 00:00 → 23:59:59.999 (local)
  setRange: (start: Date, end: Date) => void;    // accepts Dates; stored as ms
  setRangeMs: (startMs: number, endMs: number) => void;
  applyPreset: (make: () => { startDate: Date; endDate: Date }) => void; // e.g., Today/This week
  rangeISO: { from: string; to: string };        // ISO strings (UTC) for API queries
  selectedMachines: ReadonlySet<string>;
  updateSelectedMachines: (updater: (prev: ReadonlySet<string>) => ReadonlySet<string>) => void;
};

const FiltersContext = createContext<FiltersContextValue | null>(null);

/* ---------- helpers ---------- */
const normMs = (start: Date, end: Date): Range => {
  let s = startOfDay(start).getTime();
  let e = endOfDay(end).getTime();
  if (isAfter(new Date(s), new Date(e))) e = endOfDay(new Date(s)).getTime();
  return { start: s, end: e };
};
const toISO = (r: Range) => ({
  from: new Date(r.start).toISOString(),
  to:   new Date(r.end).toISOString(),
});

export const FiltersProvider: React.FC<{
  children: React.ReactNode;
  initialStart?: Date;
  initialEnd?: Date;
}> = ({ children, initialStart, initialEnd }) => {
  const s0 = initialStart ?? new Date(Date.now() - 14 * 86400000);
  const e0 = initialEnd   ?? new Date();

  const [range, _setRange] = useState<Range>(() => normMs(s0, e0));
  const [selected, setSelected] = useState<ReadonlySet<String>>(new Set());

  const setRange = useCallback((start: Date, end: Date) => {
    _setRange(normMs(start, end));
  }, []);

  const setRangeMs = useCallback((startMs: number, endMs: number) => {
    _setRange(normMs(new Date(startMs), new Date(endMs)));
  }, []);

  const applyPreset = useCallback((make: () => { startDate: Date; endDate: Date }) => {
    const { startDate, endDate } = make();
    _setRange(normMs(startDate, endDate));
  }, []);

  // ensure state updates create a NEW Set so React re-renders
  const updateSelectedMachines = useCallback(
    (updater: (prev: ReadonlySet<string>) => ReadonlySet<string>) => {
      setSelected((prev) => new Set(updater(prev)));
    },
    []
  );

  const rangeISO = useMemo(() => toISO(range), [range]);

  const value = useMemo<FiltersContextValue>(() => ({
    range,
    setRange,
    setRangeMs,
    applyPreset,
    rangeISO,
    selectedMachines: selected,
    updateSelectedMachines,
  }), [range, setRange, setRangeMs, applyPreset, rangeISO, selected, updateSelectedMachines]);

  return <FiltersContext.Provider value={value}>{children}</FiltersContext.Provider>;
};

export const useFilters = () => {
  const ctx = useContext(FiltersContext);
  if (!ctx) throw new Error('useFilters must be used within <FiltersProvider>');
  return ctx;
};
