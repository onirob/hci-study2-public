// pages/FamiliarizationReliance.tsx
import * as React from "react";
import { Box, Button, Chip, Popover, Stack, Typography } from "@mui/material";
import { useFlow } from "../context/FlowProvider";
import Reliance from "./Reliance";

type StepId = "explain" | "items" | "slider" | "submitTip";
type Step = {
  id: StepId;
  selector: string;
  title: string;
  body: string;
  anchor: { vertical: "top" | "bottom"; horizontal: "left" | "right" | "center" };
};

const STEPS: Step[] = [
  {
    id: "explain",
    selector: '[data-tour="rel-intro"]',
    title: "About Tendency to Use",
    body: "After each task, you’ll answer three tems about whether you’d act on the system’s output .",
    anchor: { vertical: "bottom", horizontal: "left" },
  },
  {
    id: "items",
    selector: '[data-tour="rel-items"]',
    title: "Three statements",
    body: "Each statement asks about relying on the system in a different way: acting on it alone, acting after a colleague checks, or acting after a tool verifies.",
    anchor: { vertical: "top", horizontal: "center" },
  },
  {
    id: "slider",
    selector: '[data-tour="rel-one-slider"]',
    title: "Rating scale",
    body: "Rate from 1 (Unlikely) to 7 (Likely). The midpoint 4 means Neutral/Unsure.",
    anchor: { vertical: "bottom", horizontal: "center" },
  },
  {
    id: "submitTip",
    selector: '[data-tour="rel-submit"]',
    title: "Submitting",
    body: "In the real study, “Proceed to next task” saves your answers. To continue now and proceed with the study, click “I’m ready”.",
    anchor: { vertical: "top", horizontal: "right" },
  },
];

export default function FamiliarizationReliance() {
  const { next } = useFlow();
  const [i, setI] = React.useState(0);
  const step = STEPS[i];
  const done = i === STEPS.length - 1;

  const [anchorEl, setAnchorEl] = React.useState<HTMLElement | null>(null);

  React.useEffect(() => {
    const update = () => setAnchorEl(document.querySelector(step.selector) as HTMLElement | null);
    update();
    const id = setInterval(update, 200);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      clearInterval(id);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [step.selector]);


    // Auto-scroll the highlighted element into view (handles nested scroll containers)
    React.useEffect(() => {
      if (!anchorEl) return;
  
      const block: ScrollLogicalPosition =
        step.anchor.vertical === 'top' ? 'start' :
        step.anchor.vertical === 'bottom' ? 'end' : 'center';
  
      // Find nearest scrollable ancestor; fall back to window
      const getScrollParent = (el: HTMLElement | null): HTMLElement | Window => {
        let p: HTMLElement | null = el?.parentElement ?? null;
        while (p) {
          const s = getComputedStyle(p);
          if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && p.scrollHeight > p.clientHeight) {
            return p;
          }
          p = p.parentElement;
        }
        return window;
      };
  
      // Wait a tick for layout/Drawer to finish
      const id = window.setTimeout(() => {
        const parent = getScrollParent(anchorEl);
        if (parent instanceof Window) {
          anchorEl.scrollIntoView({ behavior: 'smooth', block, inline: 'nearest' });
        } else {
          // Center within the scroll container
          const r = anchorEl.getBoundingClientRect();
          const pr = parent.getBoundingClientRect();
          const delta = (r.top - pr.top) - (parent.clientHeight / 2 - r.height / 2);
          parent.scrollBy({ top: delta, behavior: 'smooth' });
        }
      }, 50);
  
      return () => window.clearTimeout(id);
    }, [i, step.id, anchorEl, step.anchor.vertical]);

  return (
    <Box sx={{ height: 1, minHeight: 0, display: "flex", flexDirection: "column", px: 2, py: 3 }}>
      {/* Render the REAL Reliance page in preview mode */}
      <Reliance preview />

      <FocusRing target={anchorEl} />

      <Popover
        open={!!anchorEl}
        anchorEl={anchorEl}
        onClose={() => {}}
        disableEscapeKeyDown
        disableAutoFocus
        disableEnforceFocus
        anchorOrigin={{ vertical: step.anchor.vertical, horizontal: step.anchor.horizontal }}
        transformOrigin={{ vertical: "top", horizontal: "left" }}
        slotProps={{ paper: { sx: { p: 2, maxWidth: 420, zIndex: (t) => t.zIndex.modal + 1 } } }}
      >
        <Typography variant="subtitle2" gutterBottom>{step.title}</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>{step.body}</Typography>
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Chip label={`${i + 1} / ${STEPS.length}`} size="small" />
          <Box>
            <Button onClick={() => setI(s => Math.max(0, s - 1))} disabled={i === 0} sx={{ mr: 1 }}>Back</Button>
            {!done ? (
              <Button variant="contained" onClick={() => setI(s => Math.min(STEPS.length - 1, s + 1))}>Next</Button>
            ) : (
              <Button variant="contained" onClick={next}>I’m ready</Button>
            )}
          </Box>
        </Stack>
      </Popover>
    </Box>
  );
}

function FocusRing({ target }: { target: HTMLElement | null }) {
  const [rect, setRect] = React.useState<DOMRect | null>(null);
  React.useEffect(() => {
    if (!target) { setRect(null); return; }
    const update = () => setRect(target.getBoundingClientRect());
    update();
    const ro = new ResizeObserver(update);
    ro.observe(document.body);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    const id = setInterval(update, 150);
    return () => {
      ro.disconnect(); clearInterval(id);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      clearInterval(id);
    };
  }, [target]);

  if (!rect) return null;
  const pad = 6;
  return (
    <Box sx={{
      position: "fixed",
      top: rect.top - pad,
      left: rect.left - pad,
      width: rect.width + pad * 2,
      height: rect.height + pad * 2,
      border: "2px solid",
      borderColor: "primary.main",
      borderRadius: 2,
      pointerEvents: "none",
      zIndex: (t) => t.zIndex.modal,
    }}/>
  );
}
