// src/telemetry/AllClickCapture.tsx
import { useEffect, useRef, useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { useFlow } from '../context/FlowProvider';

type TelemetryEvtOut = {
  client_event_id?: string;  // dedupe key; optional
  event_type: string;        // 'click' | 'page_view' | 'submit' | ...
  target?: string;
  client_ts_ms?: number;
  t_perf_ms?: number;
  seq?: number;
  vp_w?: number;
  vp_h?: number;
  payload?: Record<string, any>;
};

type Mode = 'dashboard' | 'ui' | 'chatbot';

type Queued = {
  evt: TelemetryEvtOut;
  mode: Mode;
  surface: string;          // used for ui endpoint query param
  route: string;            // used for ui endpoint query param
  task_code: string | null; // sent at batch level
  conversation_id?: string | null; // used for chatbot endpoint query param
};

const DEFAULT_DASHBOARD_PREFIXES = ['/dashboard'];
const DEFAULT_CHATBOT_PREFIXES = ['/chatbot'];

const INTERACTIVE_SEL = [
  'button','a[href]','input','select','textarea',
  '[role="button"]','[role="link"]','[contenteditable="true"]',
  '[role="radio"]','[role="radiogroup"]','[role="slider"]', '[role="checkbox"]',
  '.MuiRadio-root','.MuiFormControlLabel-root', '.MuiCheckbox-root',
  '.MuiSlider-root','.MuiSlider-thumb','.MuiSlider-rail','.MuiSlider-track',
  '.MuiButtonBase-root','.MuiIconButton-root','.MuiTabs-root [role="tab"]',
  '.recharts-bar-rectangle','.recharts-line-curve','.recharts-scatter-symbol','.recharts-legend-item',
].join(',');

function findArea(el: Element | null): HTMLElement | null {
  while (el && el !== document.body) {
    if ((el as HTMLElement).dataset?.areaid) return el as HTMLElement;
    el = el.parentElement!;
  }
  return document.body as HTMLElement;
}
function closestEid(el: Element | null): string | undefined {
  while (el && el !== document.body) {
    const eid = (el as HTMLElement).dataset?.eid;
    if (eid) return eid;
    el = el.parentElement!;
  }
}
function isInteractive(el: Element | null): boolean {
  if (!el) return false;
  if ((el as HTMLElement).closest(INTERACTIVE_SEL)) return true;
  if ((el as HTMLElement).closest('[data-eid]')) return true;
  return false;
}
function shortSig(el: Element): string {
  const he = el as HTMLElement;
  const tag = el.tagName.toLowerCase();
  const id = he.id ? `#${he.id}` : '';
  const role = he.getAttribute('role');
  const cls = he.className && typeof he.className === 'string'
    ? '.' + he.className.split(/\s+/).slice(0,2).join('.')
    : '';
  return `${tag}${id}${cls}${role ? `[role=${role}]` : ''}`;
}
function shortCssPath(el: Element | null, limit = 4): string {
  const parts: string[] = [];
  while (el && parts.length < limit && el !== document.body) {
    const he = el as HTMLElement;
    const tag = el.tagName.toLowerCase();
    const id = he.id ? `#${he.id}` : '';
    const de = he.dataset?.eid ? `[data-eid="${he.dataset.eid}"]` : '';
    parts.unshift(`${tag}${id}${de}`);
    el = el.parentElement!;
  }
  return parts.join('>');
}

// Human-friendly targets
function getRole(el: HTMLElement): string | undefined {
  return el.getAttribute('role') ?? undefined;
}
function getKind(el: HTMLElement): string {
  const tag = el.tagName.toLowerCase();
  const role = getRole(el);
  if (role) return role;
  if (tag === 'button') return 'button';
  if (tag === 'a') return 'link';
  if (tag === 'input') return 'input';
  if (tag === 'select') return 'select';
  if (tag === 'textarea') return 'textarea';
  return tag;
}
function getAssociatedLabel(el: HTMLElement): string | undefined {
  const aria = el.getAttribute('aria-label');
  if (aria?.trim()) return aria.trim();

  const labelledby = el.getAttribute('aria-labelledby');
  if (labelledby) {
    const txt = labelledby
      .split(/\s+/)
      .map(id => document.getElementById(id)?.textContent?.trim())
      .filter(Boolean)
      .join(' ');
    if (txt) return txt;
  }

  const id = el.getAttribute('id');
  if (id) {
    const esc = (globalThis as any).CSS?.escape ? (globalThis as any).CSS.escape(id) : id;
    const lab = document.querySelector(`label[for="${esc}"]`) as HTMLLabelElement | null;
    const t = lab?.textContent?.trim();
    if (t) return t;
  }

  const placeholder = el.getAttribute('placeholder');
  if (placeholder?.trim()) return placeholder.trim();

  const title = el.getAttribute('title');
  if (title?.trim()) return title.trim();

  const txt = el.textContent?.replace(/\s+/g, ' ').trim();
  if (txt) return txt.slice(0, 80);
}
function findInteractiveAnchor(target: Element | null): HTMLElement | null {
  if (!target) return null;
  const viaSelector = (target as HTMLElement).closest(INTERACTIVE_SEL) as HTMLElement | null;
  if (viaSelector) return viaSelector;
  const viaEid = (target as HTMLElement).closest('[data-eid]') as HTMLElement | null;
  if (viaEid) return viaEid;
  return target as HTMLElement;
}

function inferMode(pathname: string, dashboardPrefixes: string[], chatbotPrefixes: string[]): Mode {
  const p = pathname.toLowerCase();
  if (dashboardPrefixes.some(px => p.startsWith(px))) return 'dashboard';
  if (chatbotPrefixes.some(px => p.startsWith(px))) return 'chatbot';
  return 'ui';
}

function inferSurface(pathname: string): string {
  const p = pathname.toLowerCase();
  if (p.includes('familiar')) return 'familiarization';
  if (p.includes('nasa') || p.includes('tlx') || p.includes('bdli') || p.includes('reliance') || p.includes('tech') || p.includes('prescreen') || p.includes('imc')) {
    return 'questionnaire';
  }
  if (p.includes('intro')) return 'intro';
  if (p.includes('end')) return 'end';
  return 'page';
}

function buildUrl(base: string, params: Record<string, string | undefined | null>) {
  const u = new URL(base, window.location.origin);
  Object.entries(params).forEach(([k,v]) => {
    if (v !== undefined && v !== null && `${v}`.length) u.searchParams.set(k, `${v}`);
  });
  // return relative (keeps your /api proxy behavior)
  return u.pathname + (u.search ? u.search : '');
}

/**
 * Global telemetry capture.
 * Mount ONCE (e.g., in StudyLayout).
 */
export function useAllClickCapture(
  opts: {
    flushMs?: number;
    disabled?: boolean;
    dashboardIngestUrl?: string;
    uiIngestBase?: string;
    chatbotIngestBase?: string;
    dashboardPathPrefixes?: string[];
    chatbotPathPrefixes?: string[];
    conversationId?: string | null;
    capturePageViews?: boolean;
    captureSubmits?: boolean;
  } = {}
) {
  const { participantId, session, fetchWithSession, currentTaskCode } = useFlow();
  const location = useLocation();

  const flushMs = opts.flushMs ?? 4000;
  const disabled = opts.disabled ?? false;
  const dashboardIngestUrl = opts.dashboardIngestUrl ?? '/api/telemetry/dashboard/batch';
  const uiIngestBase = opts.uiIngestBase ?? '/api/telemetry/ui/batch';
  const chatbotIngestBase = opts.chatbotIngestBase ?? '/api/telemetry/chatbot/batch';
  const dashboardPathPrefixes = opts.dashboardPathPrefixes ?? DEFAULT_DASHBOARD_PREFIXES;
  const chatbotPathPrefixes = opts.chatbotPathPrefixes ?? DEFAULT_CHATBOT_PREFIXES;
  const conversationId = opts.conversationId ?? null;
  const capturePageViews = opts.capturePageViews ?? true;
  const captureSubmits = opts.captureSubmits ?? true;


  const q = useRef<Queued[]>([]);
  const seq = useRef(0);

  const routeRef = useRef<string>(location.pathname);
  const taskRef = useRef<string | null>(currentTaskCode ?? null);
  const convRef = useRef<string | null>(conversationId ?? null);

  useEffect(() => { routeRef.current = location.pathname; }, [location.pathname]);
  useEffect(() => { taskRef.current = currentTaskCode ?? null; }, [currentTaskCode]);
  useEffect(() => { convRef.current = conversationId ?? null; }, [conversationId]);

  const enqueue = useCallback((evt: Omit<TelemetryEvtOut, 'client_event_id'|'client_ts_ms'|'t_perf_ms'|'seq'> & { client_event_id?: string }) => {
    const route = routeRef.current || '/';
    const mode = inferMode(route, dashboardPathPrefixes, chatbotPathPrefixes);
    const surface = mode === 'ui' ? inferSurface(route) : mode;

    const out: TelemetryEvtOut = {
      ...evt,
      client_event_id: evt.client_event_id ?? (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`),
      client_ts_ms: Date.now(),
      t_perf_ms: performance.now(),
      seq: ++seq.current,
      vp_w: window.innerWidth,
      vp_h: window.innerHeight,
      payload: {
        ...(evt.payload ?? {}),
        // meta kept inside payload (safe: no schema change)
        route,
        surface,
        mode,
        conversation_id: convRef.current ?? undefined,
      },
    };

    q.current.push({
      evt: out,
      mode,
      surface,
      route,
      task_code: taskRef.current,
      conversation_id: convRef.current ?? undefined,
    });
  }, [dashboardPathPrefixes, chatbotPathPrefixes]);
  
  const enqueueRef = useRef(enqueue);
  useEffect(() => { enqueueRef.current = enqueue; }, [enqueue]);

  const sendBatch = useCallback((url: string, task_code: string | null, events: TelemetryEvtOut[]) => {
    if (!events.length) return;

    // If there's no session token, don't spam 401s.
    if (!session?.token) return;

    const payload = {
      participant_id: participantId ?? null,
      session_id: session?.id ?? null,
      task_code: task_code ?? null,
      write_token: session?.token ?? null, // for sendBeacon fallback
      events,
    };

    const body = JSON.stringify(payload);

    fetchWithSession(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {
      if (navigator.sendBeacon) {
        try { navigator.sendBeacon(url, new Blob([body], { type: 'application/json' })); } catch {}
      }
    });
  }, [participantId, session, fetchWithSession]);

  const flush = useCallback(() => {
    if (!q.current.length) return;

    const batch = q.current.splice(0, q.current.length);

    // group by destination URL + task_code (batch-level task_code)
    const groups = new Map<string, { url: string; task_code: string | null; events: TelemetryEvtOut[] }>();

    for (const item of batch) {
      let url: string;

      if (item.mode === 'dashboard') {
        url = dashboardIngestUrl;
      } else if (item.mode === 'chatbot') {
        url = buildUrl(chatbotIngestBase, { conversation_id: item.conversation_id ?? undefined });
      } else {
        url = buildUrl(uiIngestBase, {
          surface: item.surface,
          route: item.route,
        });
      }

      const task_code = item.mode === 'ui'
        ? (item.task_code ?? null) // keep if you have it (useful for TLX-after-task)
        : (item.task_code ?? null);

      const key = `${url}::${task_code ?? ''}`;
      const g = groups.get(key) ?? { url, task_code, events: [] };
      g.events.push(item.evt);
      groups.set(key, g);
    }

    for (const g of groups.values()) {
      sendBatch(g.url, g.task_code, g.events);
    }
  }, [dashboardIngestUrl, uiIngestBase, chatbotIngestBase, sendBatch]);

  const flushRef = useRef(flush);
  useEffect(() => { flushRef.current = flush; }, [flush]);

  // Flush when route changes (prevents mixing pages in the same request)
  useEffect(() => {
    if (disabled) return;

    if (capturePageViews) {
      // flush previous page events first
      flush();
      enqueueRef.current({
        event_type: 'page_view',
        target: `route:${location.pathname}`,
        payload: { referrer: document.referrer || undefined },
      });
    } else {
      flush();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  useEffect(() => {
    if (disabled) return;

    const onPointerUp = (e: PointerEvent) => {
      const rawTarget = e.target as Element | null;

      const eid = closestEid(rawTarget);
      if (eid) {
        const el = (rawTarget as HTMLElement) || document.body;
        const kind = getKind(el);
        const label = getAssociatedLabel(el);
        enqueueRef.current({
          event_type: 'click',
          target: `${kind}:${label ?? eid}`,
          payload: {
            kind,
            role: getRole(el),
            label: label ?? undefined,
            id: el.id || undefined,
            name: (el as HTMLInputElement).name || undefined,
            path: shortCssPath(rawTarget),
            button: e.button,
            sig: shortSig(el),
            dataValue: el.getAttribute('data-value') || undefined,
          },
        });
        return;
      }

      if (isInteractive(rawTarget)) {
        const el = findInteractiveAnchor(rawTarget) as HTMLElement;
        const kind = getKind(el);
        const label = getAssociatedLabel(el);
        const dataValue = el.getAttribute('data-value') || undefined;
        const pretty = label ?? dataValue ?? shortSig(el);

        enqueueRef.current({
          event_type: 'click',
          target: `${kind}:${pretty}`,
          payload: {
            kind,
            role: getRole(el),
            label: label ?? undefined,
            dataValue,
            id: el.id || undefined,
            name: (el as HTMLInputElement).name || undefined,
            path: shortCssPath(el),
            button: e.button,
            sig: shortSig(el),
          },
        });
        return;
      }

      const area = findArea(rawTarget);
      const rect = area.getBoundingClientRect();
      const x_rel = (e.clientX - rect.left) / (rect.width || 1);
      const y_rel = (e.clientY - rect.top) / (rect.height || 1);
      const areaid = (area.dataset?.areaid || 'document');

      enqueueRef.current({
        event_type: 'click',
        target: `empty:${areaid}`,
        payload: {
          areaid,
          x_rel: Math.max(0, Math.min(1, +x_rel.toFixed(3))),
          y_rel: Math.max(0, Math.min(1, +y_rel.toFixed(3))),
          button: e.button,
        },
      });
    };

    const onSubmit = (e: Event) => {
      if (!captureSubmits) return;
      const form = e.target as HTMLFormElement | null;
      const sig = form ? shortSig(form) : 'form';
      enqueueRef.current({
        event_type: 'submit',
        target: `submit:${sig}`,
        payload: {
          path: form ? shortCssPath(form) : undefined,
          active: (document.activeElement as HTMLElement | null)?.tagName?.toLowerCase() ?? undefined,
        },
      });
    };

    document.addEventListener('pointerup', onPointerUp, { capture: true, passive: true });
    document.addEventListener('submit', onSubmit, { capture: true });

    const id = window.setInterval(() => flushRef.current(), flushMs);
    const onHide = () => flushRef.current();
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onHide);

    return () => {
      document.removeEventListener('pointerup', onPointerUp, true);
      document.removeEventListener('submit', onSubmit, true);
      clearInterval(id);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onHide);
    };
  }, [flushMs, disabled, captureSubmits]);
}
