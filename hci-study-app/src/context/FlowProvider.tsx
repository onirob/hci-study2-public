// src/context/FlowProvider.tsx
import {
  createContext, useContext, useState, useEffect, useRef, useMemo, useCallback, type ReactNode,
} from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { buildFlow, type InterfaceAssignment, type Section } from '../flow';
import { readProlificParams, type ProlificParams } from '../utils/prolific';
import { apiPath } from '../utils/api';
import { getTaskForSection } from '../utils/task';
import type { Task } from '../components/TaskPanel';


// --- Types ---
export type StudySession = {
  id: string;
  token: string;
  startedAt?: string;
};

type BonusDetail = {
  task_code: string;
  amount_minor: number;     // e.g., 150
  amount_eur: number;       // e.g., 1.5
  reason: string;           // e.g., "accuracy>=0.90"
  created_at?: string | null;
};

type EndSummary = {
  ok: boolean;
  session_id: string;
  participant_id: string;
  session_ended_at?: string | null;
  participant_status: string;        // "completed" | "timed_out" | "rejected" ...
  completed_at?: string | null;
  eligibility_status?: string | null;
  ineligible_reason?: string | null;
  attention_passed?: boolean | null;
  comprehension_passed?: boolean | null;
  completion_code?: string | null;
  bonuses_created?: number;
  bonuses_detail?: BonusDetail[];
};

type FlowCtx = {
  next: () => void;
  back: () => void;
  currentIdx: number;

  ready: boolean;
  participantId?: string;
  setParticipantId: (id?: string) => void;
  prolific?: ProlificParams;
  error?: string;
  devMode: boolean;

  assignment?: InterfaceAssignment;
  setAssignment: (a: InterfaceAssignment) => void;

  session?: StudySession;
  setSession: (s?: StudySession) => void;
  startSession: (pidOverride?: string) => Promise<StudySession>;
  endAndExit: (reason: EndReason, opts?: { finalStatus?: FinalStatus; endedAt?: string }) => Promise<void>;
  fetchWithSession: (url: string, init?: RequestInit) => Promise<Response>;

  endSummary?: EndSummary;
  setEndSummary: (s?: EndSummary) => void;

  imcFails: number;
  imcShown: number;
  shouldShowAdaptiveImc: boolean;  // render a 3rd IMC only for those with a prior fail
  recordImc: (e: Omit<ImcEvent, 'ts'>) => Promise<{ screenedOut: boolean }>;

  // Expose the computed flow and current section
  plan: Section[];
  section: Section;
  currentTask: Task | null;
  currentTaskCode: string | null;
  currentCycle: number | null;
};

// --- IMC types/state ---
type ImcEvent = {
  id: string;             // e.g., "imc_techfam_1"
  page: string;           // e.g., "TechFam"
  label?: string;         // optional human-readable label
  passed: boolean;
  response?: string | number; // what they clicked, if useful
  ts?: number;            // filled in by controller
};

const IMC_THRESHOLD_FAILS = 2; // apply unconditionally (study ~30min)
const CC_THRESHOLD_FAILS  = 2;

const CC_LABELS = new Set<string>([
  'tlx_performance_direction',
  'reliance_comprehension',
]);



export type EndReason =
  | 'completed'
  | 'session_lost'
  | 'session_invalid'
  | 'already_in_progress'
  | 'device_mismatch'
  | 'rejected'
  | 'attention_failed'
  | 'comprehension_failed'
  | 'prescreen_excluded'
  | 'quit'
  | 'timed_out'; 

type FinalStatus = 'completed' | 'timed_out' | 'rejected';


const Ctx = createContext<FlowCtx>(null!);
export const useFlow = () => useContext(Ctx);

export function FlowProvider({ children }: { children: ReactNode }) {
  const nav = useNavigate();
  const location = useLocation();
  const didInit = useRef(false);

  // --- IMC state (not persisted)
  const imcQueue = useRef<ImcEvent[]>([]);
  const [imcShown, setImcShown] = useState(0);
  const [imcFails, setImcFails] = useState(0);
  const imcFailsRef = useRef(0);
  const imcSeenIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => { imcFailsRef.current = imcFails; }, [imcFails]);
  // --- CC (Comprehension) state (not persisted)
  const [ccShown, setCcShown] = useState(0);
  const ccFailsRef = useRef(0);
  const ccSeenIdsRef = useRef<Set<string>>(new Set());

  const shouldShowAdaptiveImc = imcFails > 0;

  const [ready, setReady] = useState(false);
  const [participantId, setParticipantId] = useState<string | undefined>(() =>
    sessionStorage.getItem('participant_id') ?? undefined
  );
  const [prolific, setProlific] = useState<ProlificParams | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [devMode, setDevMode] = useState(false);
  const lastGuardRef = useRef<{ path: string; t: number } | null>(null);

  // --- Assignment: start undefined (or cached)
  const [assignment, _setAssignment] = useState<InterfaceAssignment | undefined>(() => {
    const cached = sessionStorage.getItem('assignment');
    return cached === 'dashboard' || cached === 'chatbot' ? (cached as InterfaceAssignment) : undefined;
  });
  const setAssignment = (a: InterfaceAssignment) => {
    // override to test dashboard or chatbot only
    // leave VITE_FORCE_INTERFACE empty for normal behavior
    // if VITE_FORCE_INTERFACE is not empty, it takes precedence
    const force_interface=import.meta.env.VITE_FORCE_INTERFACE;
    if (force_interface === 'dashboard' || force_interface === 'chatbot') a = force_interface;
    _setAssignment(a);
    sessionStorage.setItem('assignment', a);
  };

  // --- Session: persisted in sessionStorage as a JSON blob
  const [session, _setSession] = useState<StudySession | undefined>(() => {
    const raw = sessionStorage.getItem('session');
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.id && parsed?.token) return parsed as StudySession;
    } catch {}
    return undefined;
  });

  const setSession = (s?: StudySession) => {
    _setSession(s);
    if (s) sessionStorage.setItem('session', JSON.stringify(s));
    else sessionStorage.removeItem('session');
  };

  const [endSummary, setEndSummary] = useState<EndSummary | undefined>(undefined);

  // Build plan reactively: pre only (no assignment) → pre+post (after assignment)
  const plan = useMemo(() => buildFlow(assignment, 3), [assignment]);

  const idxFromPath = () => {
    const i = plan.findIndex((s) => s.path === location.pathname);
    return i === -1 ? 0 : i;
  };
  const [currentIdx, setIdx] = useState<number>(() => idxFromPath());

  useEffect(() => {
    setIdx(idxFromPath());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, plan]);

  // Current section (safe fallback to first)
  const section = plan[currentIdx] ?? plan[0];

  const { task: currentTask, code: currentTaskCode, cycle: currentCycle } =
  useMemo(() => getTaskForSection(section), [section]);

  const allowDev =
    //import.meta.env.DEV ||
    //window.location.hostname === 'localhost' ||
    import.meta.env.VITE_ALLOW_FAKE_PROLIFIC === 'true' ||
    new URLSearchParams(location.search).has('dev');

  function makeDevProlificParams(): ProlificParams {
    const qp = new URLSearchParams(window.location.search);
    const pidKey = 'DEV_PROLIFIC_PID';
    const forced = qp.get('FAKE_PID');
    let pid =
      forced ||
      sessionStorage.getItem(pidKey) ||
      `dev_${(crypto as any)?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
    sessionStorage.setItem(pidKey, pid);
    const sess = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const study = 'DEV-STUDY-LOCAL';
    return { prolific_pid: pid, prolific_study_id: study, prolific_session_id: sess };
  }

  // One-time init: consent page will register; we just prep Prolific params
  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;

    let params = readProlificParams();
    if (!params && allowDev) {
      params = makeDevProlificParams();
      setDevMode(true);
    }
    if (params) setProlific(params);
    if (!params) {
      setError('Missing Prolific parameters. Please start from Prolific.');
      setReady(false);
      return;
    }
    setReady(true);
    if (location.search) nav(location.pathname, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

    // --- Helper: start session (idempotent on the server)
  const startSession = useCallback(async (pidOverride?: string): Promise<StudySession> => {
    const pid = pidOverride ?? participantId;
    if (!pid) throw new Error('Cannot start session: missing participantId.');

    const res = await fetch(apiPath('/sessions/start'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ participant_id: pid }),
    });

    if (!res.ok) {
      // optional: parse structured error
      let code: string | undefined;
      try {
        const err = await res.clone().json();
        code = err?.detail?.code || err?.code;
      } catch {}
      // bubble up; caller decides whether to route to /end
      throw new Error(code || `HTTP ${res.status}`);
    }

    const { session_id, write_token } = await res.json();
    const s: StudySession = { id: String(session_id), token: String(write_token) };
    setSession(s);
    return s;
  }, [participantId]);

  // --- Helper: end session
  const endSession = useCallback(
    async (finalStatus: 'completed'|'timed_out'|'rejected' = 'completed', ended_at?: string) => {
      if (!session) return undefined;

      try {
        const res = await fetch(apiPath('/sessions/end'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Session-Write-Token': session.token,
          },
          body: JSON.stringify({ session_id: session.id, ended_at, final_status: finalStatus }),
        });

        let data: EndSummary | undefined;
        try { data = await res.clone().json(); } catch { /* non-JSON edge case */ }

        setEndSummary(data);
        setSession(undefined);
        return data;
      } catch (e) {
        console.warn('[Flow] endSession error:', e);
        setSession(undefined);
        return undefined;
      }
    },
    [session]
  );

  
  // --- Helper: end & exit (guarded against double calls)
  const endingRef = useRef(false);

  const mapReasonToStatus = (reason: EndReason): FinalStatus => {
    switch (reason) {
      case 'completed':         return 'completed';
      case 'rejected':
      case 'attention_failed':  return 'rejected';
      case 'comprehension_failed':  return 'rejected';
      case 'prescreen_excluded':return 'rejected';
      default:                  return 'timed_out'; // session_lost, session_invalid, device_mismatch, already_in_progress, quit
    }
  };

  const clearVolatileStorage = () => {
    try {
      sessionStorage.removeItem('session');
      // optional: uncomment if you want a harder reset after exit
      // sessionStorage.removeItem('assignment');
      // sessionStorage.removeItem('participant_id');
      // sessionStorage.removeItem('plan');
    } catch {}
  };

  // IMC Controller: posting + flushing
  const postImcBatch = useCallback(async (batch: ImcEvent[]) => {
    if (!batch.length) return;
    if (!session?.token || !session?.id) throw new Error('No active session for IMC post');
    if (!participantId) throw new Error('No participantId for IMC post');

    const payload = {
      responses: batch.map(ev => ({
        // required by QuestionnaireResponse
        participant_id: participantId,                 // UUID string
        // optional (allowed by schema)
        session_id: session.id,                        // Optional[UUID]; safe to include
        questionnaire_name: CC_LABELS.has(ev.label ?? '') ? 'Comprehension' : 'IMC',
        item_key: ev.id,
        value_numeric: ev.passed ? 1 : 0,
        value_text: ev.response != null ? String(ev.response) : null,
        submitted_at: ev.ts ? new Date(ev.ts).toISOString() : null,
      })),
    };

    const res = await fetch(apiPath('/questionnaires/responses/batch'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Write-Token': session.token,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`IMC batch HTTP ${res.status} ${t}`);
    }
  }, [session?.token, session?.id, participantId]);

  const flushImcQueue = useCallback(async () => {
    if (!imcQueue.current.length) return;
    const copy = imcQueue.current.slice();
    imcQueue.current = []; // optimistic
    try {
      await postImcBatch(copy);
    } catch (e) {
      imcQueue.current.unshift(...copy); // restore
      throw e;
    }
  }, [postImcBatch]);

  // Post participant-level attention snapshot using direct fetch (no fetchWithSession)
  const postAttentionDirect = useCallback(async (payload: any) => {
    if (!session?.token || !session?.id) return { ok: false, skipped: true };
    let data: any = null;
    const res = await fetch(apiPath('/attention'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Write-Token': session.token,
      },
      body: JSON.stringify(payload),
    });
    try { data = await res.clone().json(); } catch {}
    return { ok: res.ok, status: res.status, data };
  }, [session?.token, session?.id]);

  const postComprehensionDirect = useCallback(async (payload: any) => {
    if (!session?.token || !session?.id) return { ok: false, skipped: true };
    let data: any = null;
    const res = await fetch(apiPath('/comprehension'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Write-Token': session.token,
      },
      body: JSON.stringify(payload),
    });
    try { data = await res.clone().json(); } catch {}
    return { ok: res.ok, status: res.status, data };
  }, [session?.token, session?.id]);

  

  const endAndExit = useCallback(
    async (reason: EndReason, opts?: { finalStatus?: FinalStatus; endedAt?: string }) => {
      if (endingRef.current) return;
      endingRef.current = true;

      try { await flushImcQueue(); } catch {}

      try {
        await postAttentionDirect({
          events: [],
          shown: imcShown,
          fails: imcFailsRef.current,
          adaptive_shown: imcFailsRef.current > 0,
          screened_out: reason === 'attention_failed',
          attention_passed: imcFailsRef.current < IMC_THRESHOLD_FAILS,
          notes: { end_reason: reason, ended_at: opts?.endedAt ?? new Date().toISOString() }
        });
      } catch {}

      try {
        await postComprehensionDirect({
          events: [],
          shown: ccShown,
          fails: ccFailsRef.current,
          adaptive_shown: ccFailsRef.current > 0,
          screened_out: reason === 'comprehension_failed',
          comprehension_passed: ccFailsRef.current < CC_THRESHOLD_FAILS,
          notes: { end_reason: reason, ended_at: opts?.endedAt ?? new Date().toISOString() }
        });
      } catch {}

      const finalStatus = opts?.finalStatus ?? mapReasonToStatus(reason);
      let data: EndSummary | undefined;
      try { data = await endSession(finalStatus, opts?.endedAt); } catch {}

      // Keep clearing volatile storage as you do
      setSession(undefined);
      clearVolatileStorage();

      nav(`/end?reason=${encodeURIComponent(reason)}`, {
        replace: true,
        // Optional: also pass a copy via router state
        state: data ? { endSummary: data } : undefined
      });
    },
    [endSession, nav, flushImcQueue, postAttentionDirect, imcShown, postComprehensionDirect, ccShown]
  );



  // --- Navigation helpers
  const goto = useCallback((i: number) => {
    if (i < 0 || i >= plan.length) return;
    if (!ready) {
      console.warn('[Flow] Not ready yet; gating navigation.');
      return;
    }
    setIdx(i);
    nav(plan[i].path, { replace: true });
  }, [ready, plan, nav]);

  const goNext = useCallback(() => {
    const nextIdx = currentIdx + 1;

    // 1) Beyond last section → finalize
    if (nextIdx >= plan.length) {
      void endAndExit('completed', { finalStatus: 'completed' });
      return;
    }

    // 2) If the *next* section is the End page, finalize before navigating
    const nextSection = plan[nextIdx];
    const isTerminal =
      nextSection?.path === '/end' ||
      (nextSection as any)?.isTerminal === true ||        // if you mark terminal sections in buildFlow
      (nextSection as any)?.kind === 'end';               // if you use a kind/tag

    if (isTerminal) {
      void endAndExit('completed', { finalStatus: 'completed' });
      return; // endAndExit will navigate to /end?reason=completed
    }

    // 3) Otherwise, proceed normally
    goto(nextIdx);
  }, [currentIdx, plan, goto, endAndExit]);


  // --- Helper: nuke session on unload
  useEffect(() => {
    const clearOnUnload = () => {
      try {
        sessionStorage.removeItem('session'); // <-- your key
        // (optional) also clear other volatile keys if you persist any:
        sessionStorage.removeItem('assignment');
        sessionStorage.removeItem('plan');
      } catch {}
    };

    // beforeunload covers most browsers; pagehide covers iOS Safari
    window.addEventListener('beforeunload', clearOnUnload);
    window.addEventListener('pagehide', clearOnUnload);
    return () => {
      window.removeEventListener('beforeunload', clearOnUnload);
      window.removeEventListener('pagehide', clearOnUnload);
    };
  }, []);

    useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (!session) return;
      e.preventDefault();
      e.returnValue = ''; // triggers generic browser prompt
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [session]);

  useEffect(() => {
    if (assignment && !session) {
      endAndExit('session_lost');
    }
  }, [assignment, session, endAndExit]);

  // --- Helper: fetch wrapper that auto-injects write token for mutating calls
  const fetchWithSession = useCallback(
    async (url: string, init: RequestInit = {}, opts?: { includeTokenOnGet?: boolean }) => {
      const headers = new Headers(init.headers || {});
      const method = (init.method || 'GET').toUpperCase();
      const isMut = /POST|PUT|PATCH|DELETE/.test(method);

      // For mutating calls, enforce presence of a session
      if (isMut && !session) {
        await endAndExit('session_lost');
        throw new Error('No active session');
      }

      // Attach token for muts OR when explicitly requested for GETs
      const shouldAttach = (isMut || opts?.includeTokenOnGet) && session && !headers.has('X-Session-Write-Token');
      if (shouldAttach) headers.set('X-Session-Write-Token', session.token);

      const res = await fetch(url, { ...init, headers });

      // Centralized handling for 401/403 (works for GET too)
      if (res.status === 401 || res.status === 403) {
        try {
          const err = await res.clone().json();
          const code = err?.detail?.code || err?.code;
          if (code === 'missing_token' || code === 'invalid_or_closed_token') {
            await endAndExit('session_invalid');
          } else if (code === 'device_mismatch') {
            await endAndExit('device_mismatch');
          }
        } catch { /* ignore JSON parse errors */ }
      }

      return res;
    },
    [session, endAndExit]
  );

  const guardSession = useCallback(async (path?: string, taskCode?: string) => {
    if (!session?.token) return false;

    const qs = new URLSearchParams();
    if (path) qs.set('path', path);
    if (taskCode) qs.set('task_code', taskCode);

    const res = await fetchWithSession(
      apiPath(`/sessions/guard?${qs.toString()}`),
      { method: 'GET' },
      { includeTokenOnGet: true }   // <-- this is the only new thing you need
    );
    return res.ok;
  }, [session?.token, fetchWithSession]);

  useEffect(() => {
    const path = location.pathname;
    if (path === '/intro' || path === '/') return;

    // 1) If there is NO session token after a reload ⇒ end immediately.
    if (!session?.token) {
      void endAndExit('session_lost');
      return;
    }

    // 2) If we DO have a token, ping the server guard (with light de-dupe).
    const now = Date.now();
    if (lastGuardRef.current && lastGuardRef.current.path === path && (now - lastGuardRef.current.t) < 1000) {
      return;
    }

    let cancelled = false;
    (async () => {
      const ok = await guardSession(path, currentTaskCode ?? undefined);
      if (!ok) return; // fetchWithSession will have triggered endAndExit
      if (!cancelled) lastGuardRef.current = { path, t: Date.now() };
    })();

    return () => { cancelled = true; };
  }, [location.pathname, session?.token, guardSession, endAndExit, currentTaskCode]);

  const recordImc = useCallback(async (inEv: Omit<ImcEvent,'ts'>) => {
    const ev: ImcEvent = { ...inEv, ts: Date.now() };

    const isCC = !!ev.label && CC_LABELS.has(ev.label);

    const seenRef = isCC ? ccSeenIdsRef : imcSeenIdsRef;
    const currentShown = isCC ? ccShown : imcShown;
    const currentFails = isCC ? ccFailsRef.current : imcFailsRef.current;
    const thresholdFails = isCC ? CC_THRESHOLD_FAILS : IMC_THRESHOLD_FAILS;

    // Count a given id at most once (within its bucket)
    const firstTime = !seenRef.current.has(ev.id);
    if (firstTime) seenRef.current.add(ev.id);

    const newShown = firstTime ? currentShown + 1 : currentShown;
    const newFails = firstTime && !ev.passed ? currentFails + 1 : currentFails;

    // Update local state/refs (bucket-specific)
    if (firstTime) {
      if (isCC) setCcShown(s => s + 1);
      else setImcShown(s => s + 1);
    }

    if (firstTime && !ev.passed) {
      if (isCC) {
        ccFailsRef.current = newFails;
      } else {
        setImcFails(() => newFails);
        imcFailsRef.current = newFails;
      }
    }

    // Log granular item (questionnaire_responses)
    imcQueue.current.push(ev);
    try { await flushImcQueue(); } catch { /* best-effort */ }

    const payload = {
      events: [{
        id: ev.id,
        page: ev.page,
        label: ev.label,
        passed: ev.passed,
        response: ev.response,
        ts: ev.ts
      }],
      shown: newShown,
      fails: newFails,
      adaptive_shown: newFails > 0,
      screened_out: newFails >= thresholdFails,
      notes: { path: location.pathname, duplicate: !firstTime }
    };

    const resp = isCC
      ? await postComprehensionDirect(payload)
      : await postAttentionDirect(payload);

    // Server-enforced threshold (403)
    const code = resp.data?.detail?.code || resp.data?.code;

    if (resp.status === 403 && code === 'attention_threshold_reached') {
      try { await flushImcQueue(); } catch {}
      await endAndExit('attention_failed', { finalStatus: 'rejected' });
      return { screenedOut: true };
    }

    if (resp.status === 403 && code === 'comprehension_threshold_reached') {
      try { await flushImcQueue(); } catch {}
      await endAndExit('comprehension_failed', { finalStatus: 'rejected' });
      return { screenedOut: true };
    }

    if (!resp.ok && resp.status !== 403) {
      console.warn(`[IMC] ${isCC ? '/comprehension' : '/attention'} non-OK:`, resp.status, resp.data);
    }

    return { screenedOut: false };
  }, [
    flushImcQueue,
    endAndExit,
    postAttentionDirect,
    postComprehensionDirect,
    imcShown,
    ccShown,
    location.pathname
  ]);



  return (
    <Ctx.Provider
      value={{
        currentIdx,
        next: goNext,
        back: () => goto(currentIdx - 1),
        ready,
        participantId,
        setParticipantId,
        prolific,
        error,
        devMode,
        assignment,
        setAssignment,

        session,
        setSession,
        startSession,
        endAndExit,
        fetchWithSession,

        endSummary,
        setEndSummary,

        imcFails,
        imcShown,
        shouldShowAdaptiveImc,
        recordImc,

        plan,
        section,
        currentTask,          // Task | null
        currentTaskCode,      // string | null
        currentCycle,         // number | null
      }}
    >
      {children}
    </Ctx.Provider>
  );
}
