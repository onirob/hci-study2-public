import * as React from 'react';
import { Box, Button, Popover, Typography, Container, Stack, Chip, Dialog, DialogTitle, DialogContent, DialogActions,
  List, ListItem, ListItemText } from '@mui/material';
import Dashboard from './Dashboard';
import { useFlow } from '../context/FlowProvider';
import { useCoachAnchor } from '../hooks/useCoachAnchor';

type View = 'status' | 'consumption' | 'productivity';

type Step =
  | {
      id: 'timerIntro';
      selector: string;
      title: string;
      body: string;
      forceView: View;
      anchor: { vertical: 'top' | 'bottom'; horizontal: 'left' | 'right' | 'center' };
    }
  | {
      id: 'taskIntro';
      selector: string;
      title: string;
      body: string;
      forceView: View;
      anchor: { vertical: 'top' | 'bottom'; horizontal: 'left' | 'right' | 'center' };
      // special: click "I read the task" only when user presses Next on this step
      clickOnAdvanceSelector?: string;
    }
  | {
      id: 'views' | 'date' | 'charts' | 'table' | 'machine-page';
      selector: string;
      title: string;
      body: string;
      forceView: View;
      anchor: { vertical: 'top' | 'bottom'; horizontal: 'left' | 'right' | 'center' };
      autoClickSelector?: string; // auto-open responses when entering first interface step
      enterDelayMs?: number;
    }
  | {
      id: 'finalActions';
      selector: string;
      title: string;
      body: string;
      forceView: View;
      anchor: { vertical: 'top' | 'bottom'; horizontal: 'left' | 'right' | 'center' };
    }
  | {
      id: 'graceExplain';
      selector: string;
      title: string;
      body: string;
      forceView: View;
      anchor: { vertical: 'top' | 'bottom'; horizontal: 'left' | 'right' | 'center' };
    };

const STEPS: Step[] = [
  // Step 0 — explain timer box
  {
    id: 'timerIntro',
    selector: '[data-tour="timer-box"]',
    title: 'Task timer',
    body:
      'Here you will see how much time you have to complete the current task. ' +
      'No countdown will be shown to avoid any pressure. ' +
      'Near the end, you will see a brief reminder. You will have 1 minute to finish the task once the reminder appears.',
    forceView: 'status',
    anchor: { vertical: 'bottom', horizontal: 'right' },
  },

  
  // Step 1 — explain task panel + timer concept + "I read the task"
  {
    id: 'taskIntro',
    selector: '[data-tour="task-sidebar"]',
    title: 'Task panel & start',
    body:
      'This panel shows the task. When you press “I read the task”, the task begins and the timer starts. ',
    forceView: 'status',
    anchor: { vertical: 'top', horizontal: 'right' },
    clickOnAdvanceSelector: '[data-tour="fam-acknowledge"]',
  },

  // Step 2 — interface steps (we auto-open responses on the first interface step)
  {
    id: 'views',
    selector: '[data-tour="view-tabs"]',
    title: 'Views',
    body: 'Switch between Status, Consumption, and Productivity to change to a different view of the data.',
    forceView: 'status',
    anchor: { vertical: 'bottom', horizontal: 'left' },
    autoClickSelector: '[data-tour="fam-show-responses"]',
    enterDelayMs: 250,
  },
  {
    id: 'date',
    selector: '[data-tour="date-filter"]',
    title: 'Date filter',
    body: 
      'Pick a period in the calendar filter.' +
      'Remember: the experiment time is fixed to 5 Nov 2025, 11:30 AM',
    forceView: 'status',
    anchor: { vertical: 'bottom', horizontal: 'right' },
  },
  {
    id: 'charts',
    selector: '[data-tour="chart-area"]',
    title: 'Charts',
    body: 'Charts show trends (e.g., consumption, power, OEE). ',
    forceView: 'consumption',
    anchor: { vertical: 'top', horizontal: 'right' },
  },
  {
    id: 'table',
    selector: '[data-tour="machine-table"]',
    title: 'Machines table',
    body: 'Compare machines and read per-row metrics. Useful for rankings/justifications. '+
          'Clicking on a machine name you will open a view with the specific info about that machine (then click X on the top right to return to this view"',
    forceView: 'productivity',
    anchor: { vertical: 'top', horizontal: 'right' },
  },

  // Step 3 — show submit in normal flow (no auto-click)
  {
    id: 'finalActions',
    selector: '[data-tour="task-actions"]',
    title: 'Submitting your answer',
    body:
      'When you have selected or typed your response, you can submit it here.',
    forceView: 'status',
    anchor: { vertical: 'top', horizontal: 'right' },
  },

  // Step 4 — show grace period (no ticking timer; StudyLayout renders the real grace UI)
  {
    id: 'graceExplain',
    selector: '[data-tour="task-sidebar"]',
    title: 'Final seconds (grace)',
    body:
      'When the time is up, you will enter a grace period. During this time, the main interface will be blocked and you will only be able to submit or submit without an answer. ' +
      "  If you don't do anything, the study automatically carries on with a 'no answer'.",
    forceView: 'status',
    anchor: { vertical: 'top', horizontal: 'right' },
  },
];


export default function FamiliarizeDashboard() {
  const { next } = useFlow();
  const [i, setI] = React.useState(0);
  const step = STEPS[i];

  // require drawer only for drawer-related anchors
  const requireDrawer = /\b(task-sidebar|task-actions|fam-)\b/.test(step.selector);
  const anchorEl = useCoachAnchor(step.selector, requireDrawer);
  const drawerReady = !!document.body.dataset.drawerReady;
  const canShow = (!requireDrawer || drawerReady) && !!anchorEl;


  const [welcomeOpen, setWelcomeOpen] = React.useState(
    () => sessionStorage.getItem('famWelcomeSeen') !== '1'
  );

  const startTour = () => {
    sessionStorage.setItem('famWelcomeSeen', '1');
    setWelcomeOpen(false);
  };

  // keep Dashboard remounted per forceView to ensure layout anchors exist
  const dashKey = step.forceView + '-' + step.id;

  // On step enter: optionally auto-click (open responses on first interface step)
  React.useEffect(() => {
    if ('autoClickSelector' in step && step.autoClickSelector) {
      const delay = step.enterDelayMs ?? 200;
      let tries = 10;
      const timer = window.setInterval(() => {
        const el = document.querySelector(step.autoClickSelector!) as HTMLElement | null;
        if (el) {
          el.click();
          window.clearInterval(timer);
        } else if (--tries <= 0) {
          window.clearInterval(timer);
        }
      }, delay);
      return () => window.clearInterval(timer);
    }
  }, [i, step]);

  // Grace demo: tell StudyLayout to enter/exit preview phases (no ticking)
  React.useEffect(() => {
    // Turn on grace while we're on the last step; otherwise clear
    if (step.id === 'graceExplain') {
      window.dispatchEvent(new CustomEvent('demo:setPhase', { detail: { phase: 'grace' } }));
    } else {
      window.dispatchEvent(new Event('demo:clearPhase'));
    }
    return () => {
      // clean up if user navigates away
      window.dispatchEvent(new Event('demo:clearPhase'));
    };
  }, [step.id]);

  const back = () => setI((s) => Math.max(0, s - 1));
  const forward = () => {
    // If we are on Step 1 and user presses Next → click the *real* “I read the task”
    if (step.id === 'taskIntro' && 'clickOnAdvanceSelector' in step && step.clickOnAdvanceSelector) {
      const el = document.querySelector(step.clickOnAdvanceSelector) as HTMLElement | null;
      el?.click();
    }
    setI((s) => Math.min(STEPS.length - 1, s + 1));
  };
  const done = i === STEPS.length - 1;

  // Auto-scroll the highlighted element into view (handles nested scroll containers)
  React.useEffect(() => {
    if (!canShow || !anchorEl) return;

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
  }, [i, step.id, canShow, anchorEl, step.anchor.vertical]);

  const popoverTransformOrigin = React.useMemo(
    () => ({
      vertical: step.anchor.vertical === 'bottom' ? 'bottom' : 'top',
      horizontal: 'left',
    }),
    [step.anchor.vertical]
  );

  return (
    <Container maxWidth="lg" sx={{ py: 3, position: 'relative' }}>
      {/* Welcome dialog */}
      <Dialog
        open={welcomeOpen}
        onClose={startTour}                 // keep it simple: closing == start
        fullWidth
        maxWidth="sm"
        aria-labelledby="fam-welcome-title"
      >
        <DialogTitle id="fam-welcome-title">Welcome — Scenario overview</DialogTitle>
        <DialogContent dividers>
          <List dense>
            <ListItem alignItems="flex-start">
              <ListItemText
                primary="Scenario — Metal-cutting factory"
                secondary={
                  <>
                    <Typography variant="body2" sx={{ mb: 1 }}>
                      You will take the role of a <strong>factory manager</strong> in a simulated factory that includes <strong>16 machines</strong>.
                    </Typography>

                    {/* Types only, compact and scannable */}
                    <Box
                      sx={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: 0.75,
                      }}
                    >
                      {[
                        'Assembly machines',
                        'Cutting machines — Large capacity',
                        'Cutting machines — Medium capacity',
                        'Cutting machines — Low capacity',
                        'Laser cutter',
                        'Laser welders',
                        'Riveting machine',
                        'Testing machines',
                      ].map((t) => (
                        <Chip key={t} label={t} size="small" />
                      ))}
                    </Box>
                  </>
                }
              />
            </ListItem>
            <ListItem>
              <ListItemText
                primary="Fixed scenario time"
                secondary="All tasks take place on 5 Nov 2025 at 11:30 AM. Data, events, and charts are anchored to that moment."
              />
            </ListItem>
            <ListItem>
              <ListItemText
                primary="Familiarization"
                secondary="Next, a short guided tour will help you get comfortable with the tool and the brief questionnaires after each task."
              />
            </ListItem>
          </List>
        </DialogContent>
        <DialogActions>
          <Button variant="contained" onClick={startTour}>Start the tour</Button>
        </DialogActions>
      </Dialog>
    {!welcomeOpen && (
      <>
        <Dashboard key={dashKey} demo forceView={step.forceView} />

        {/* Focus ring around target */}
        {canShow && <FocusRing target={anchorEl} />}

        {/* Coachmark popover */}
        {canShow && (
          <Popover
            open={canShow}
            anchorEl={anchorEl ?? undefined}
            onClose={() => {}}
            disableEscapeKeyDown
            disableAutoFocus
            disableEnforceFocus
            anchorOrigin={{ vertical: step.anchor.vertical, horizontal: step.anchor.horizontal }}
            transformOrigin={{ vertical: 'top', horizontal: 'left' }}
            marginThreshold={16} 
            slotProps={{ paper: { sx: { p: 2, maxWidth: 420, zIndex: (t) => t.zIndex.modal + 10 } } }}
          >
            <Typography variant="subtitle2" gutterBottom>{step.title}</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
              {step.body}
            </Typography>

            <Stack direction="row" justifyContent="space-between" alignItems="center">
              <Chip label={`${i + 1} / ${STEPS.length}`} size="small" />
              <Box>
                <Button onClick={back} disabled={i === 0} sx={{ mr: 1 }}>Back</Button>
                {!done ? (
                  <Button variant="contained" onClick={forward}>Next</Button>
                ) : (
                  <Button variant="contained" onClick={next}>Understood</Button>
                )}
              </Box>
            </Stack>
          </Popover>
        )}
      </>
    )}
    </Container>
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
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    const id = window.setInterval(update, 150);
    return () => {
      ro.disconnect();
      window.clearInterval(id);
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [target]);

  if (!rect) return null;
  const pad = 6;

  return (
    <Box
      sx={{
        position: 'fixed',
        top: rect.top - pad,
        left: rect.left - pad,
        width: rect.width + pad * 2,
        height: rect.height + pad * 2,
        border: '2px solid',
        borderColor: 'primary.main',
        borderRadius: 2,
        pointerEvents: 'none',
        zIndex: (t) => t.zIndex.modal,
      }}
    />
  );
}
