export function isNonDesktop(): boolean {
  if (typeof navigator === 'undefined') return false; // safety for SSR/tests

  const ua = navigator.userAgent || '';

  // Treat phones & tablets as non-desktop.
  // No touchscreen checks, just OS / device keywords.
  return /Android|webOS|iPhone|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|Tablet|iPad/i.test(ua);
}
