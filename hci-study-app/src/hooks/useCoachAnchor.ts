// hooks/useCoachAnchor.ts
import * as React from 'react';

export function useCoachAnchor(selector: string, requireDrawer = false) {
  const [el, setEl] = React.useState<HTMLElement | null>(null);

  React.useEffect(() => {
    let alive = true;

    const resolve = () => {
      if (requireDrawer && !document.body.dataset.drawerReady) {
        if (alive) setEl(null);
        return;
      }
      const n = document.querySelector(selector) as HTMLElement | null;
      if (alive) setEl(n);
    };

    // resolve on next paint + observe DOM (covers portals, transitions, lazy mounts)
    const raf = requestAnimationFrame(resolve);
    const mo = new MutationObserver(resolve);
    mo.observe(document.body, { childList: true, subtree: true });

    // backstop polling (rare edge cases)
    const id = setInterval(resolve, 200);

    // also re-resolve after window resize/scroll (layout shifts)
    const onWin = () => resolve();
    window.addEventListener('resize', onWin);
    window.addEventListener('scroll', onWin, true);

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      mo.disconnect();
      clearInterval(id);
      window.removeEventListener('resize', onWin);
      window.removeEventListener('scroll', onWin, true);
    };
  }, [selector, requireDrawer]);

  return el;
}
