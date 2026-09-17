// Normalize VITE_API_BASE and join paths safely.
const RAW_BASE = import.meta.env.VITE_API_BASE ?? "/api";

// If you want to allow absolute bases (e.g., "http://localhost:8787")
// this keeps them intact; otherwise we’ll keep it relative ("/api").
const isAbsolute = /^(?:https?:)?\/\//i.test(RAW_BASE);
const BASE = isAbsolute
  ? RAW_BASE.replace(/\/+$/, "") // strip trailing slashes
  : ("/" + RAW_BASE.replace(/^\/+/, "").replace(/\/+$/, "")); // ensure single leading slash

export function apiPath(path: string): string {
  const p = "/" + path.replace(/^\/+/, "");           // ensure one leading slash
  return isAbsolute ? `${BASE}${p}` : `${BASE}${p}`;  // works for both forms
}


export async function guardSession(path?: string, taskCode?: string): Promise<boolean> {
  const token = sessionStorage.getItem('hci:session_write_token'); // set this after /sessions/start
  if (!token) return false;
  const qs = new URLSearchParams();
  if (path) qs.set('path', path);
  if (taskCode) qs.set('task_code', taskCode);

  const res = await fetch(`/api/sessions/guard?${qs.toString()}`, {
    method: 'GET',
    headers: { 'X-Session-Write-Token': token },
  });

  if (res.ok) return true;

  // Decide what to do on 401/403 (redirect, show modal, end & exit, etc.)
  // Optionally inspect JSON for detail.code (missing_token, invalid_or_closed_token, participant_closed_status)
  return false;
}