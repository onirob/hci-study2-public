// All VITE_* settings are public build-time values. Never put credentials here.
export const externalActionsEnabled = import.meta.env.VITE_ENABLE_EXTERNAL_ACTIONS === 'true';
export const supportEmail = (import.meta.env.VITE_SUPPORT_EMAIL || '').trim();

export function navigateStudyExternal(target: string): void {
  if (!externalActionsEnabled) return;
  if (target.startsWith('mailto:')) {
    if (!supportEmail || (target !== `mailto:${supportEmail}` && !target.startsWith(`mailto:${supportEmail}?`))) return;
  } else {
    const url = new URL(target);
    if (url.origin !== 'https://app.prolific.com' ||
        url.pathname !== '/submissions/complete' || !url.searchParams.get('cc')) return;
  }
  window.location.href = target;
}
