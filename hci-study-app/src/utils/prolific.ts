export type ProlificParams = {
  prolific_pid: string;
  prolific_study_id?: string;
  prolific_session_id?: string;
};

export function readProlificParams(): ProlificParams | null {
  const qp = new URLSearchParams(window.location.search);

  const pid   = (qp.get("PROLIFIC_PID") || sessionStorage.getItem("PROLIFIC_PID") || "").trim();
  const study = (qp.get("STUDY_ID")     || sessionStorage.getItem("STUDY_ID")     || "").trim();
  const sess  = (qp.get("SESSION_ID")   || sessionStorage.getItem("SESSION_ID")   || "").trim();

  // Persist new arrivals so navigation doesn’t lose them
  if (qp.get("PROLIFIC_PID")) sessionStorage.setItem("PROLIFIC_PID", pid);
  if (qp.get("STUDY_ID"))     sessionStorage.setItem("STUDY_ID", study);
  if (qp.get("SESSION_ID"))   sessionStorage.setItem("SESSION_ID", sess);

  if (!pid) return null; // Missing IDs are handled by the artificial-identity option for local testing.

  return {
    prolific_pid: pid,
    prolific_study_id: study || undefined,
    prolific_session_id: sess || undefined,
  };
}
