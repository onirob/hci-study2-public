import { useRef, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';
import {
  AppBar, Toolbar, Typography, Box, Drawer, Snackbar, Dialog, DialogTitle,
  DialogContent, Button, Alert, Stack, Paper
} from '@mui/material';
import LinearProgress from '@mui/material/LinearProgress';
import { Outlet } from 'react-router-dom';
import { useFlow } from '../context/FlowProvider';
import { useTimer } from '../context/TimerProvider';
import TaskPanel, { validateTask } from '../components/TaskPanel';
import { TASKS_BY_CYCLE, FAM_TASK } from '../data/tasks';
import { apiPath } from '../utils/api';

// telemetry
import { useAllClickCapture } from '../telemetry/AllClickCapture';

const drawerWidth = 400;
const STAGE_BAR_H = 32; // px
type IntervalId = ReturnType<typeof setInterval>;

export default function StudyLayout() {
  const flow = useFlow();
  const {
    ready, currentCycle, next, plan, section, participantId, currentTaskCode,
    session, fetchWithSession, } = flow;


  const mainRef = useRef<HTMLDivElement>(null);
  const { pathname, search, hash } = useLocation();
  const navType = useNavigationType();

  useAllClickCapture();

  // 1) Route-driven scroll (window back/forward keeps position)
  useEffect(() => {
    if (hash) return;                 // don't override in-page anchors
    if (navType !== 'POP') {
      mainRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, [pathname, search, hash, navType]);

  // 2) Section-driven scroll (covers same-path step changes, e.g., TechFam)
  useEffect(() => {
    // after layout reflows
    requestAnimationFrame(() => {
      mainRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }, [section?.id, section?.path, section?.cycle]);

  // Timer context
  const { phase, secondsLeft, startAdvanced, stop } = useTimer();

  // --- Coach-driven preview of phases (for familiarization) ---
  const [phaseOverride, setPhaseOverride] = useState<null | 'prewarn' | 'grace'>(null);
  useEffect(() => {
    const onSet = (e: any) => setPhaseOverride(e?.detail?.phase ?? null);
    const onClear = () => setPhaseOverride(null);
    window.addEventListener('demo:setPhase', onSet as EventListener);
    window.addEventListener('demo:clearPhase', onClear);
    return () => {
      window.removeEventListener('demo:setPhase', onSet as EventListener);
      window.removeEventListener('demo:clearPhase', onClear);
    };
  }, []);
  const effectivePhase = phaseOverride ?? phase;

 // Build compact stages: Familiarization, Cycle 1..N, Finish
  const stages = useMemo(() => {
    const cycleSet = new Set<number>();
    for (const s of plan) {
      if ((s as any)?.cycle && (s.id === 'task' || s.id === 'tlx' || s.id === 'reliance')) {
        cycleSet.add((s as any).cycle);
      }
    }
    const cycles = Array.from(cycleSet).sort((a, b) => a - b);

    return [
      { key: 'fam', label: 'Familiarization' },
      ...cycles.map(c => ({ key: `cycle${c}`, label: `Task ${c}` })),
      { key: 'end', label: 'Finish' },
    ];
  }, [plan]);

    // Track which task we last primed; allows priming once per task code
  const lastPrimedTask = useRef<string | null>(null);

    useEffect(() => {
      // Only prime once Flow is ready and we have a task code
      if (!ready || !currentTaskCode) return;

      // Avoid duplicate primes for the same task
      if (lastPrimedTask.current === currentTaskCode) return;
      lastPrimedTask.current = currentTaskCode;

      // Fire-and-forget: server records server-side time
      fetchWithSession(apiPath(`/tasks/${currentTaskCode}/prime`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_render_ms: Date.now(), // optional diagnostics
        }),
        keepalive: true,
      }).catch(() => {});
    }, [ready, currentTaskCode, currentCycle]);

  // Map current section to a stage index; return -1 for pre-fam (hidden)
  const currentStageIdx = useMemo(() => {
    if (!section) return -1;
    const sid = (section as any).id;

    // Familiarization bundle
    if (sid === 'fam' || sid === 'tlx_preview' || sid === 'imc1' || sid === 'reliance_preview') {
      return 0; // 'fam'
    }
    // Cycles: task/tlx/reliance grouped by cycle
    if ((sid === 'task' || sid === 'tlx' || sid === 'reliance') && (section as any).cycle) {
      return stages.findIndex(s => s.key === `cycle${(section as any).cycle}`);
    }
    // IMC2 (after cycle 1) — group under Cycle 1 to avoid extra dot
    if (sid === 'imc2') {
      return stages.findIndex(s => s.key === 'cycle1');
    }
    // End
    if (sid === 'end') {
      return stages.length - 1;
    }
    // Pre-familiarization pages (intro, precheck, bdli, techfam) → hide
    return -1;
  }, [section, stages]);

  const totalStages = stages.length;
  // Drawer ready flag (for tours)



  // Drawer ready (for coach anchors)
  const [drawerPaperEl, setDrawerPaperEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (drawerPaperEl) document.body.dataset.drawerReady = '1';
    else delete document.body.dataset.drawerReady;
  }, [drawerPaperEl]);

  // Section helpers
  const isTaskLike = (s: any) =>
    s?.id === 'task' || s?.type === 'task' || s?.phase === 'task' || s?.kind === 'task';
  const isFamiliarizationLike = (s: any) =>
    s?.id === 'fam' || s?.type === 'fam' || s?.phase === 'fam' || s?.fam === true;
  const hasQuestionData = (s: any) =>
    (Array.isArray(s?.tasks) && s.tasks.length > 0) || !!s?.task ||
    (Array.isArray(s?.questions) && s?.questions.length > 0);

  const showSidebar = useMemo(() => {
    const s: any = section ?? {};
    return Boolean(
      s?.showSidebar === true || isTaskLike(s) || isFamiliarizationLike(s) || hasQuestionData(s)
    );
  }, [section]);

  const isTimed = (s: any) => (s?.seconds ?? 0) > 0;

  // Timing / submission bookkeeping
  const startedAtRef = useRef<number>(Date.now());
  const [submitting, setSubmitting] = useState(false);
  const submittedRef = useRef<boolean>(false);

  // New gating states
  const [acknowledged, setAcknowledged] = useState(false);
  const [starting, setStarting] = useState(false);
  const [responsesVisible, setResponsesVisible] = useState(false);

  // Advisory: planned minutes (no live countdown shown until grace in real tasks)
  const [plannedMinutes, setPlannedMinutes] = useState<number | null>(null);

  // End dialog + countdown
  const [endDialogOpen, setEndDialogOpen] = useState(false);
  const [endCountdown, setEndCountdown] = useState(5);
  const endTimerRef = useRef<IntervalId | null>(null);

  // Reset on section change
  useEffect(() => {
    startedAtRef.current = Date.now();
    submittedRef.current = false;
    setPlannedMinutes(null);
    setAcknowledged(false);
    setResponsesVisible(false);
    setStarting(false);
    setPhaseOverride(null);

    if (endTimerRef.current) {
      clearInterval(endTimerRef.current);
      endTimerRef.current = null;
    }
    setEndDialogOpen(false);
    setEndCountdown(5);
  }, [section?.id, section?.path, section?.cycle]);

  useEffect(() => () => {
    if (endTimerRef.current) clearInterval(endTimerRef.current);
  }, []);

  // Start/stop timer per section; DO NOT auto-start for tasks.
  useEffect(() => {
    stop(); // reset timer on any step change

    // Non-task timed steps: local timing (prewarn/grace/hard-stop), no visible countdown until grace
    if (!isTaskLike(section) && isTimed(section)) {
      const secs = section?.seconds ?? 0;
      setPlannedMinutes(Math.max(1, Math.round(secs / 60)));
      startAdvanced({
        budgetSeconds: secs,
        softStopLeadSec: 0,
        preWarnLeadSec: 60,
        graceSeconds: 60,
        onDone: handleHardStop,
      });
      return;
    }

    // For task steps, wait for "I read the task"
    if (isTaskLike(section) && isTimed(section)) {
      const secs = section?.seconds ?? 0;
      if (secs > 0) setPlannedMinutes(Math.max(1, Math.round(secs / 60)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section?.id, section?.seconds, currentTaskCode]);

  // Task lookup (fam uses a static task shell)
  const taskFromCatalog = useMemo(() => {
    const s: any = section ?? {};
    const cycleFromProp = Number.isFinite(s?.cycle) ? Number(s.cycle) : undefined;
    if (cycleFromProp) return TASKS_BY_CYCLE[cycleFromProp];
    const path = s?.path ?? '';
    const m = path.match(/^\/(?:dashboard|chatbot)\/(\d+)/);
    const cycleFromPath = m ? Number(m[1]) : undefined;
    return cycleFromPath ? TASKS_BY_CYCLE[cycleFromPath] : undefined;
  }, [section]);

  const isFam = (section as any)?.id === 'fam';

  const { activeTask, activeTaskIndex } = useMemo(() => {
    const s: any = section ?? {};
    if (s?.id === 'fam') return { activeTask: FAM_TASK, activeTaskIndex: 0 };

    const tasks =
      (Array.isArray(s?.tasks) ? s.tasks :
        s?.task ? [s.task] :
          s?.questions ? [{ code: s.code ?? 'q', title: s.title ?? 'Task', questions: s.questions }] :
            []);
    const idx = Number.isInteger(s?.taskIndex) ? s?.taskIndex : 0;
    const pick = tasks[idx] ?? taskFromCatalog;
    return { activeTask: pick, activeTaskIndex: idx };
  }, [section, taskFromCatalog]);

  const [answers, setAnswers] = useState<Record<string, string>>({});
  useEffect(() => setAnswers({}), [activeTask?.code, activeTaskIndex]);

  const [formError, setFormError] = useState<string | null>(null);
  const handleAnswerChange = (qid: string, value: string) =>
    setAnswers((prev) => ({ ...prev, [qid]: value }));

  const taskComplete = useMemo(() => {
    if (!activeTask) return false;
    return validateTask(activeTask, answers).ok;
  }, [activeTask, answers]);

  // Nudge snackbar: open when phase (effective) enters prewarn
  const [nudgeOpen, setNudgeOpen] = useState(false);
  useEffect(() => {
    if (!showSidebar) return;
    setNudgeOpen(effectivePhase === 'prewarn');
  }, [effectivePhase, showSidebar]);

  // Show countdown only during grace on task pages
  const showGraceCountdown =
  (isTaskLike(section) || isFamiliarizationLike(section)) && effectivePhase === 'grace';
  // Static seconds when coach forces grace (avoid ticking)
  const displaySeconds = phaseOverride === 'grace' ? 30 : (secondsLeft ?? 0);

  // Start timer when participant acknowledges the task
  const handleAcknowledgeStart = async () => {
    if (isFam) {
      setAcknowledged(true);
      setResponsesVisible(false); // the tour will open responses for us in the next step
      return;
    }

    if (starting) return;
    setStarting(true);
    try {
      const secs = Number(section?.seconds ?? 0);
      const complexity = Number.isFinite(activeTask?.complexity) ? Number(activeTask!.complexity) : 0;

      const res = await fetchWithSession(apiPath(`/tasks/${currentTaskCode}/start`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          //budget_seconds: secs,        // ← tell the server how long this task is
          //prewarn_lead_sec: 60,        // keep your current policy (or read from section)
          //grace_seconds: 60,
          //complexity,                  // optional, but you already track it
        }),
      });
      if (!res.ok) throw new Error(`POST /tasks/${currentTaskCode}/start ${res.status}`);
      const data = await res.json();
      const minutes = Math.max(1, Math.round((data.ends_at_ms - data.started_at_ms) / 60000));
      setPlannedMinutes(minutes);
      startedAtRef.current = data.started_at_ms;

      startAdvanced({
        serverNowMs: data.server_now_ms,
        startedAtMs: data.started_at_ms,
        endsAtMs: data.ends_at_ms,
        softStopLeadSec: 0,
        preWarnLeadSec: data.prewarn_lead_sec ?? 60,
        graceSeconds: data.grace_seconds ?? 60,
        onDone: handleHardStop,
      });

      setAcknowledged(true);
      setResponsesVisible(true);
    } catch (err: any) {
      setFormError(err.message ?? 'Failed to start task. Please retry.');
    } finally {
      setStarting(false);
    }
  };

  // Submission helpers (server computes timing)
  const computeCommonPayload = (status: 'completed' | 'overtime' | 'skipped') => ({
    participant_id: participantId,
    session_id: session?.id,
    task_code: currentTaskCode,
    complexity: Number.isFinite(activeTask?.complexity) ? Number(activeTask?.complexity) : 0,
    status,
    accuracy_score: null,
    answer: status === 'skipped' ? null : answers,
    metadata: {
      path: (section as any)?.path ?? null,
      cycle: (section as any)?.cycle ?? null,
      interface: ((section as any)?.path || '').includes('/dashboard') ? 'dashboard'
        : ((section as any)?.path || '').includes('/chatbot') ? 'chatbot' : null,
      timer_phase: effectivePhase,
      acknowledged,
      responses_visible: responsesVisible,
    },
  });

  const handleSubmit = async () => {
    if (submittedRef.current) return;
    if (!activeTask) { next(); return; }

    if (!responsesVisible) {
      setFormError('Click “Show responses” to open the answer fields before submitting.');
      return;
    }

    const v = validateTask(activeTask, answers);
    if (!v.ok) {
      setFormError(`Please answer: ${v.missing.join(', ')}`);
      return;
    }

    const status: 'completed' | 'overtime' =
      effectivePhase === 'grace' ? 'overtime' : 'completed';

    try {
      setSubmitting(true);
      const payload = computeCommonPayload(status);
      const res = await fetchWithSession(apiPath('/task-responses'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`POST /task-responses ${res.status}`);
      submittedRef.current = true;
    } catch (err: any) {
      console.error(err);
      setFormError(err.message ?? 'Failed to submit task.');
      setSubmitting(false);
      return;
    }
    setSubmitting(false);
    setFormError(null);
    next();
  };

  const handleNoAnswer = async () => {
    if (submittedRef.current) return;
    if (!activeTask) { next(); return; }

    try {
      setSubmitting(true);
      const payload = computeCommonPayload('skipped');
      const res = await fetchWithSession(apiPath('/task-responses'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`POST /task-responses ${res.status}`);
      submittedRef.current = true;
    } catch (err: any) {
      console.error(err);
      setFormError(err.message ?? 'Failed to record skip.');
      setSubmitting(false);
      return;
    }
    setSubmitting(false);
    setFormError(null);
    next();
  };

  // Hard-stop auto-finalization + countdown dialog (uses /timeout)
  async function handleHardStop() {
    if (submittedRef.current) { next(); return; }

    try {
      setSubmitting(true);
      if (currentTaskCode) {
        await fetchWithSession(apiPath(`/tasks/${currentTaskCode}/timeout`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
      }
      submittedRef.current = true;
    } catch {
      /* best-effort */
    } finally {
      setSubmitting(false);
      setFormError(null);
    }

    setEndCountdown(5);
    setEndDialogOpen(true);
    if (endTimerRef.current) clearInterval(endTimerRef.current);
    endTimerRef.current = setInterval(() => {
      setEndCountdown((c) => {
        if (c <= 1) {
          if (endTimerRef.current) {
            clearInterval(endTimerRef.current);
            endTimerRef.current = null;
          }
          setEndDialogOpen(false);
          next();
          return 0;
        }
        return c - 1;
      });
    }, 1000);
  }

  const goNow = () => {
    if (endTimerRef.current) {
      clearInterval(endTimerRef.current);
      endTimerRef.current = null;
    }
    setEndDialogOpen(false);
    next();
  };

  const lockBeforeAck = (isTaskLike(section) || isFamiliarizationLike(section)) && !acknowledged;

  const shouldLock = lockBeforeAck || showGraceCountdown;

  return (
    <Box sx={{ display: 'flex', height: '100vh', bgcolor: 'background.default' }}>
       <AppBar position="fixed" elevation={0} sx={(t) => ({ zIndex: t.zIndex.drawer + 1 })}>
        <Toolbar sx={{ gap: 2, minHeight: 64 }}>
          <Typography
            variant="h6"
            sx={{ flexShrink: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
          >
            HCI Study - Using a Digital Tool in a Factory Scenario
          </Typography>

          <Box sx={{ flexGrow: 1 }} /> {/* pushes the right cluster to the edge */}

          {/* Right cluster: stage dots + label (and optional countdown) */}
          <Box
            sx={{
              display: 'flex', alignItems: 'center', gap: 1,
              flexShrink: 0,
              maxWidth: { xs: '50vw', md: '40vw' }, // avoid crowding
              overflow: 'hidden',
            }}
            role="group"
            aria-label="Study progress"
          >
            {currentStageIdx >= 0 && (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexShrink: 0 }}>
                {stages.map((st, i) => {
                  const isPast = i < currentStageIdx;
                  const isCurrent = i === currentStageIdx;

                  return (
                    <Box key={st.key} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      {/* dot */}
                      <Box
                        aria-label={`${st.label}${isCurrent ? ' (current)' : ''}`}
                        sx={{
                          width: 8, height: 8, borderRadius: '50%',
                          bgcolor: (isPast || isCurrent) ? 'primary.main' : 'action.disabled',
                          opacity: isPast ? 1 : isCurrent ? 1 : 0.5,
                          transition: 'background-color .2s ease, opacity .2s ease',
                        }}
                      />
                      {/* connector to the next dot */}
                      {i < stages.length - 1 && (
                        <Box
                          sx={(t) => ({
                            width: 24, height: 2,
                            bgcolor: isPast ? t.palette.primary.main : t.palette.divider,
                            opacity: isPast ? 1 : 0.5,
                            transition: 'background-color .2s ease, opacity .2s ease',
                          })}
                        />
                      )}
                    </Box>
                  );
                })}
                <Typography
                  variant="caption"
                  sx={{ ml: 1, opacity: 0.7, whiteSpace: 'nowrap', flexShrink: 0 }}
                >
                  {stages[currentStageIdx]?.label} · {currentStageIdx + 1}/{stages.length}
                </Typography>
              </Box>
            )}

            {/* Optional countdown on the far right */}
            {/* {showGraceCountdown && (
              <Box sx={{ ml: 2, display: 'flex', alignItems: 'center', gap: 1 }}>
                <Typography variant="body2" sx={{ opacity: 0.8 }}>FINAL SECONDS</Typography>
                <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                  {formatSeconds(displaySeconds)}
                </Typography>
              </Box>
            )} */}
          </Box>
        </Toolbar>
      </AppBar>
      {/* Nudge (prewarn) */}
      <Snackbar
        open={nudgeOpen}
        onClose={() => setNudgeOpen(false)}
        message="⏰ Time check, please summarize and prepare your answer."
        autoHideDuration={5000}
        anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
      />

      {/* Validation / error snackbar */}
      <Snackbar
        open={!!formError}
        onClose={() => setFormError(null)}
        message={formError ?? ''}
        autoHideDuration={4000}
        anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
      />

      {/* Sidebar with task panel */}
      {showSidebar && (
        <Drawer
          data-areaid="sidebar" 
          variant="permanent"
          anchor="left"
          PaperProps={{ 'data-tour': 'task-sidebar', ref: (el: HTMLElement | null) => setDrawerPaperEl(el) }}
          sx={{
            flexShrink: 0,
            '& .MuiDrawer-paper': { width: drawerWidth, boxSizing: 'border-box', p: 2 },
          }}
        >
          <Toolbar />                    
          <Box sx={{ height: STAGE_BAR_H }} /> 

          

          {/* Grace banner with submit options reminder */}
          {showGraceCountdown && (
            <Alert severity="error" sx={{ mb: 1 }}>
              Final seconds: you can only <b>Submit</b> or <b>Submit no answer</b>.
            </Alert>
          )}

           {/* Show countdown in AppBar ONLY during grace on task pages */}
          {showGraceCountdown && (
            <Stack direction="row" spacing={2} sx={{ mr: 1 }}>
              <Typography variant="body2" sx={{ opacity: 0.8 }}>
                FINAL SECONDS
              </Typography>
              <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                {formatSeconds(displaySeconds)}
              </Typography>
            </Stack>
          )}

          {/* Advisory (no live countdown here) */}
          {!showGraceCountdown && (isTaskLike(section) || isFamiliarizationLike(section)) && (
            <Alert severity="info" sx={{ mb: 1 }} data-tour="timer-box">
              {Number.isFinite(plannedMinutes) && plannedMinutes ? (
                <>
                  This task has a maximimum time of <b>{plannedMinutes}</b> minute{plannedMinutes === 1 ? '' : 's'}.&nbsp;
                  Your time starts when you click <b>“I read the task”</b>.
                </>
              ) : (
                <>
                  This task has a maximimum time of <b>5</b> minutes.&nbsp;
                  Your time starts when you click <b>“I read the task”</b>.
                </>
              )}
            </Alert>
          )}

          <Typography variant="subtitle1" gutterBottom sx={{ mt: 2 }}>
            {activeTask ? 'Current Task' : 'Familiarization'}
          </Typography>

          {/* Task content: show title/desc always; hide inputs until responsesVisible */}
          <Box
            className={responsesVisible ? '' : 'answers-hidden'}
            sx={{
              '&.answers-hidden .MuiFormControl-root, &.answers-hidden .MuiFormGroup-root, &.answers-hidden .MuiInputBase-root, &.answers-hidden textarea, &.answers-hidden input, &.answers-hidden [role="textbox"], &.answers-hidden .MuiRadioGroup-root, &.answers-hidden .MuiCheckbox-root, &.answers-hidden .MuiSelect-root, &.answers-hidden .MuiRating-root, &.answers-hidden .MuiSlider-root, &.answers-hidden .MuiSwitch-root':
                { display: 'none' },
            }}
          >
            <TaskPanel
              task={activeTask}
              answers={answers}
              onChange={handleAnswerChange}
            />
          </Box>

          {/* Inline CTAs under task text (real buttons; coach clicks them) */}
          <Box sx={{ mt: 1, display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
            {(!acknowledged) && (isFamiliarizationLike(section) || isTaskLike(section)) && (
              <Button
                variant="contained"
                disabled={starting}
                onClick={handleAcknowledgeStart}
                data-tour="fam-acknowledge"
              >
                {starting ? 'Starting…' : 'I read the task'}
              </Button>
            )}

            {acknowledged && !responsesVisible && (isFamiliarizationLike(section) || isTaskLike(section)) && (
              <Button
                variant="outlined"
                onClick={() => setResponsesVisible(true)}
                data-tour="fam-show-responses"
              >
                Show responses
              </Button>
            )}
          </Box>

          {/* Footer actions (no Back button) */}
          <Box data-tour="task-actions" sx={{
            mt: 2,
            display: 'flex',
            justifyContent: 'flex-end',
          }}>
            {!showGraceCountdown ? (
              responsesVisible && (
                <Button
                  onClick={handleSubmit}
                  variant="contained"
                  disabled={
                    submitting ||
                    isFamiliarizationLike(section) ||
                    !taskComplete
                  }
                  data-tour="task-submit"
                >
                  {submitting ? 'Saving…' : 'Submit & Next'}
                </Button>
              )
            ) : (
              <>
                <Button
                  onClick={handleNoAnswer}
                  color="inherit"
                  disabled={isFamiliarizationLike(section)}                 // disabled on fam
                  data-tour="task-submit-no-answer"
                >
                  Submit no answer
                </Button>
                <Button
                  onClick={handleSubmit}
                  sx={{ ml: 1 }}
                  variant="contained"
                  disabled={
                    submitting ||
                    isFamiliarizationLike(section) ||
                    !taskComplete
                  }
                  data-tour="task-submit-final"
                >
                  {submitting ? 'Saving…' : 'Submit'}
                </Button>
              </>
            )}
          </Box>
        </Drawer>
      )}

      {/* Main content (dashboard/chatbot). Block interaction before acknowledge & during grace */}
      <Box
        component="main"
        ref={mainRef}
        sx={{
          flexGrow: 1,
          p: 3,
          mt: 8,
          overflow: shouldLock ? 'hidden' : 'auto', // ← stop scroll while locked
          minWidth: 0,
          ...(showSidebar ? { ml: `${drawerWidth}px` } : {}),
          position: 'relative',
        }}
      >
        {shouldLock && (
        <Box
          sx={(t) => ({
            position: 'fixed',
            top: t.spacing(8),                 // matches mt: 8
            left: showSidebar ? drawerWidth : 0,
            right: 0,
            bottom: 0,

            zIndex: t.zIndex.modal,
            background: showGraceCountdown ? 'rgba(255,200,0,0.08)' : 'rgba(0,0,0,0.59)',
            backdropFilter: 'blur(5px)',
            cursor: 'not-allowed',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            p: 2,
            textAlign: 'center',
            pointerEvents: 'auto',
          })}
          aria-hidden
        >
          {!acknowledged ? (
            <Paper elevation={0} sx={{ p: 2 }}>
              <b>Interface locked</b>
              <div style={{ color: 'var(--mui-palette-text-secondary)' }}>
                Read the task in the left panel, then click <b>“I read the task”</b> to begin.
              </div>
            </Paper>
          ) : null}
        </Box>
      )}

        <Outlet />
      </Box>

      {/* End dialog with countdown */}
      <Dialog open={endDialogOpen} disableEscapeKeyDown>
        <DialogTitle>Time is over</DialogTitle>
        <DialogContent sx={{ pb: 3 }}>
          You will be brought to the next page automatically in <b>{endCountdown}</b> second{endCountdown === 1 ? '' : 's'}.
          <Box sx={{ mt: 2, display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
            <Button onClick={goNow} variant="contained">Go now</Button>
          </Box>
        </DialogContent>
      </Dialog>
    </Box>
  );
}

function formatSeconds(s: number) {
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${m}:${ss.toString().padStart(2, '0')}`;
}

