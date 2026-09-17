// src/context/TimerProvider.tsx
import {
  createContext, useContext, useState, useRef, useEffect, ReactNode,
} from 'react';

type IntervalId = ReturnType<typeof setInterval>;
type Phase = 'idle' | 'running' | 'prewarn' | 'soft' | 'grace' | 'ended';

type StartOptions = {
  // Choose one of the two ways to start (relative or server times):
  budgetSeconds?: number;                 // relative start: full budget (excl. grace)
  startedAtMs?: number;                   // absolute start time from server (ms)
  endsAtMs?: number;                      // end-of-budget from server (ms)
  softStopLeadSec?: number;               // default 60 (soft-stop starts this many seconds before endsAt)
  preWarnLeadSec?: number;                // default 120 (pre-warning before endsAt)
  graceSeconds?: number;                  // default 60 (submission-only window after endsAt)
  serverNowMs?: number;                   // for clock-skew correction (Date.now() on server)
  onDone: () => void;                     // called at hard-stop (end of grace)
  onPhaseChange?: (p: Phase) => void;     // e.g., to lock/throttle UI
  // Optional extension (once), granted exactly at soft-stop if engaged:
  extensionSeconds?: number;              // default 0 (disabled if 0/undefined)
  autoExtension?: boolean;                // default true
  isEngaged?: () => boolean;              // minimal engagement predicate
};

type TimerCtx = {
  phase: Phase;
  secondsLeft: number | null;             // counts to endsAt (running/soft), to graceEndsAt (grace)
  // metrics / state you may want to log:
  extended: boolean;
  pausedMs: number;
  // controls
  start: (seconds: number, onDone: () => void) => void;   // legacy, relative only
  startAdvanced: (opts: StartOptions) => void;
  stop: () => void;
  pause: (reason?: 'system' | 'manual') => void;          // pushes deadlines on resume
  resume: () => void;
  requestExtension: (seconds?: number) => boolean;        // manual grant (once)
  // (optional) expose wall-clock targets for debugging/telemetry:
  targets: {
    startedAtMs: number | null;
    preWarnAtMs: number | null;
    softStopAtMs: number | null;
    endsAtMs: number | null;
    graceEndsAtMs: number | null;
  };
};

const TimerContext = createContext<TimerCtx>(null!);
export const useTimer = () => useContext(TimerContext);

export function TimerProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [extended, setExtended] = useState(false);
  const [pausedMs, setPausedMs] = useState(0);

  // authoritative targets (ms since epoch)
  const startedAtMs = useRef<number | null>(null);
  const preWarnAtMs = useRef<number | null>(null);
  const softStopAtMs = useRef<number | null>(null);
  const endsAtMsRef  = useRef<number | null>(null);
  const graceEndsAtMsRef = useRef<number | null>(null);

  // runtime
  const serverOffsetMs = useRef<number>(0);  // server_now - Date.now()
  const paused = useRef<boolean>(false);
  const pauseStartedAtMs = useRef<number | null>(null);
  const doneCb = useRef<() => void>(() => {});
  const onPhaseChange = useRef<((p: Phase) => void) | undefined>(undefined);
  const isEngagedRef = useRef<(() => boolean) | undefined>(undefined);
  const extensionSecondsRef = useRef<number>(0);
  const autoExtensionRef = useRef<boolean>(true);
  const intervalId = useRef<IntervalId | null>(null);

  const nowMs = () => Date.now() + serverOffsetMs.current;

  const stop = () => {
    if (intervalId.current !== null) {
      clearInterval(intervalId.current);
      intervalId.current = null;
    }
    setSecondsLeft(null);
    setPhase('idle');
    setExtended(false);
    setPausedMs(0);
    paused.current = false;
    pauseStartedAtMs.current = null;
    startedAtMs.current = null;
    preWarnAtMs.current = null;
    softStopAtMs.current = null;
    endsAtMsRef.current = null;
    graceEndsAtMsRef.current = null;
    serverOffsetMs.current = 0;
  };

  const pushDeadlines = (deltaMs: number) => {
    if (preWarnAtMs.current !== null)     preWarnAtMs.current += deltaMs;
    if (softStopAtMs.current !== null)    softStopAtMs.current += deltaMs;
    if (endsAtMsRef.current !== null)     endsAtMsRef.current += deltaMs;
    if (graceEndsAtMsRef.current !== null) graceEndsAtMsRef.current += deltaMs;
  };

  const pause = (_reason?: 'system' | 'manual') => {
    if (paused.current) return;
    paused.current = true;
    pauseStartedAtMs.current = nowMs();
  };

  const resume = () => {
    if (!paused.current) return;
    const t = nowMs();
    const started = pauseStartedAtMs.current ?? t;
    const delta = Math.max(0, t - started);
    pushDeadlines(delta);
    setPausedMs((p) => p + delta);
    paused.current = false;
    pauseStartedAtMs.current = null;
  };

  const grantExtension = (seconds: number) => {
    if (extended) return false;
    const ext = Math.max(0, Math.floor(seconds));
    if (!ext) return false;
    const extMs = ext * 1000;
    if (endsAtMsRef.current !== null)     endsAtMsRef.current += extMs;
    if (graceEndsAtMsRef.current !== null) graceEndsAtMsRef.current += extMs;
    setExtended(true);
    return true;
  };

  const requestExtension = (seconds?: number) => {
    const s = seconds ?? extensionSecondsRef.current;
    return grantExtension(s);
  };

  // legacy simple start
  const start = (seconds: number, onDone: () => void) => {
    startAdvanced({
      budgetSeconds: seconds,
      onDone,
      softStopLeadSec: 60,
      preWarnLeadSec: 120,
      graceSeconds: 60,
    });
  };

  const startAdvanced = (opts: StartOptions) => {
    stop(); // reset
    const {
      budgetSeconds,
      startedAtMs: sMs,
      endsAtMs: eMs,
      softStopLeadSec = 60,
      preWarnLeadSec = 120,
      graceSeconds = 60,
      serverNowMs,
      onDone,
      onPhaseChange: onP,
      extensionSeconds = 0,
      autoExtension = true,
      isEngaged,
    } = opts;

    doneCb.current = onDone;
    onPhaseChange.current = onP;
    extensionSecondsRef.current = extensionSeconds;
    autoExtensionRef.current = autoExtension;
    isEngagedRef.current = isEngaged;

    if (serverNowMs) {
      serverOffsetMs.current = serverNowMs - Date.now();
    }

    // derive timeline
    let startMs: number;
    let endMs: number;
    if (sMs && eMs) {
      startMs = sMs;
      endMs = eMs;
    } else if (budgetSeconds != null) {
      startMs = nowMs();
      endMs = startMs + budgetSeconds * 1000;
    } else {
      throw new Error('Timer start requires either (budgetSeconds) or (startedAtMs + endsAtMs).');
    }

    const softAt = endMs - softStopLeadSec * 1000;
    const preAt  = endMs - preWarnLeadSec * 1000;
    const graceEnd = endMs + graceSeconds * 1000;

    startedAtMs.current = startMs;
    preWarnAtMs.current = Math.min(preAt, softAt); // ensure prewarn ≤ soft
    softStopAtMs.current = softAt;
    endsAtMsRef.current = endMs;
    graceEndsAtMsRef.current = graceEnd;

    // initial phase & seconds
    const computePhase = (t: number): Phase => {
      if (t < (preWarnAtMs.current ?? t - 1)) return 'running';
      if (t < (softStopAtMs.current ?? t - 1)) return 'prewarn';
      if (t < (endsAtMsRef.current ?? t - 1))  return 'soft';
      if (t < (graceEndsAtMsRef.current ?? t - 1)) return 'grace';
      return 'ended';
    };

    const t0 = nowMs();
    const initPhase = computePhase(t0);
    setPhase(initPhase);

    const secsForPhase = (t: number, ph: Phase) => {
      const target =
        ph === 'grace' ? graceEndsAtMsRef.current! : endsAtMsRef.current!;
      return Math.max(0, Math.ceil((target - t) / 1000));
    };
    setSecondsLeft(secsForPhase(t0, initPhase));

    // tick
    intervalId.current = setInterval(() => {
      if (!endsAtMsRef.current || !graceEndsAtMsRef.current) return;
      const t = nowMs();

      // transitions
      let next = computePhase(t);

      // auto-extension: trigger exactly at entry into 'soft'
      if (next === 'soft' && autoExtensionRef.current && !extended) {
        const engaged = isEngagedRef.current ? !!isEngagedRef.current() : false;
        if (extensionSecondsRef.current > 0 && engaged) {
          const granted = grantExtension(extensionSecondsRef.current);
          if (granted) {
            // re-evaluate phase after pushing targets (still 'soft')
            next = computePhase(t);
          }
        }
      }

      setSecondsLeft(secsForPhase(t, next));
      if (next !== phase) {
        setPhase(next);
        onPhaseChange.current?.(next);
      }

      if (next === 'ended') {
        clearInterval(intervalId.current!);
        intervalId.current = null;
        doneCb.current();
      }
    }, 250); // smoother than 1s; cheap

    return;
  };

  useEffect(() => stop, []);

  return (
    <TimerContext.Provider
      value={{
        phase,
        secondsLeft,
        extended,
        pausedMs,
        start,
        startAdvanced,
        stop,
        pause,
        resume,
        requestExtension,
        targets: {
          startedAtMs: startedAtMs.current,
          preWarnAtMs: preWarnAtMs.current,
          softStopAtMs: softStopAtMs.current,
          endsAtMs: endsAtMsRef.current,
          graceEndsAtMs: graceEndsAtMsRef.current,
        },
      }}
    >
      {children}
    </TimerContext.Provider>
  );
}
