// src/pages/TechFam.tsx
import * as React from 'react';
import { useMemo, useEffect, useState, useRef } from 'react';
import {
  Alert, Box, Button, Card, CardContent, CardHeader, Container,
  Divider, Grid, Radio, RadioGroup, FormControlLabel, Stack, Typography,
  FormControl, FormHelperText
} from '@mui/material';
import { useParams } from 'react-router-dom';
import { useFlow } from '../context/FlowProvider';
import { apiPath } from '../utils/api';

type TechKey = 'dashboard' | 'chatbot';
type FamKey = 'use_3m' | 'capability';
type FamValues = Partial<Record<TechKey, Partial<Record<FamKey, number>>>>;

const TECHS: Array<{ key: TechKey; label: string }> = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'chatbot',  label: 'Chatbot' },
];

const USE_OPTS = [
  { v: 0, label: 'Never' },
  { v: 1, label: 'Rarely (≤ monthly)' },
  { v: 2, label: 'Often (weekly)' },
  { v: 3, label: 'Very often (daily)' },
];

const CAP_OPTS = [
  { v: 0, label: 'No experience (need guidance for basics)' },
  { v: 1, label: 'Beginner (simple tasks with occasional help)' },
  { v: 2, label: 'Intermediate (independent on routine tasks)' },
  { v: 3, label: 'Advanced/Expert (optimize, integrate, troubleshoot)' },
];

const BATCH_ENDPOINT  = apiPath('/questionnaires/responses/batch');
const ASSIGN_ENDPOINT = apiPath('/participants/assign');

// --- IMC local constants ---
const IMC_ID = 'imc_techfam_1';
const IMC_PAGE = 'TechFam';
type ImcChoice = '' | 'apple' | 'banana' | 'orange';

export default function TechFam() {
  const {
    next, participantId, setAssignment, fetchWithSession, assignment,
    recordImc
  } = useFlow();

  const [submitting, setSubmitting] = useState(false);
  const [advanceWhenReady, setAdvanceWhenReady] = useState(false);
  const { cycle } = useParams<{ cycle?: string }>();
  const [values, setValues] = useState<FamValues>({});
  const [showErrors, setShowErrors] = useState(false);

  // --- IMC local state
  const [imcChoice, setImcChoice] = useState<ImcChoice>('');
  const [imcShowError, setImcShowError] = useState(false);
  const imcRef = useRef<HTMLDivElement | null>(null);
  const registerImcRef = (el: HTMLDivElement | null) => {
    imcRef.current = el;
    itemRefs.current['imc'] = el; // unify with itemRefs
  };

  type KeyRef = `${TechKey}.${FamKey}`;
  type MissingKey = KeyRef | 'imc';
  const itemRefs = useRef<Record<MissingKey, HTMLDivElement | null>>({} as any);

  useEffect(() => {
    const raw = localStorage.getItem(storageKeyTech(cycle));
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed?.values) setValues(parsed.values as FamValues);
      } catch {/* ignore */}
    }
  }, [cycle]);

  useEffect(() => {
    if (advanceWhenReady && assignment) {
      next();
      setAdvanceWhenReady(false);
    }
  }, [advanceWhenReady, assignment, next]);

  const techOk = useMemo(() => (
    TECHS.every(t =>
      typeof values[t.key]?.use_3m === 'number' &&
      typeof values[t.key]?.capability === 'number'
    )
  ), [values]);

  const allAnswered = techOk && !!imcChoice; // optional (for UI text only)

  const missingKeys = useMemo<MissingKey[]>(() => {
    const miss: MissingKey[] = [];
    for (const t of TECHS) {
      if (typeof values[t.key]?.use_3m !== 'number') miss.push(`${t.key}.use_3m`);
      if (typeof values[t.key]?.capability !== 'number') miss.push(`${t.key}.capability`);
    }
    if (!imcChoice) miss.push('imc'); // add IMC as a missing case
    return miss;
  }, [values, imcChoice]);

  // Raw familiarity (0..6)
  const famRaw = (tech: TechKey) =>
    (values[tech]?.use_3m ?? 0) + (values[tech]?.capability ?? 0);

  const score = (tech: TechKey) => famRaw(tech) / 6;

  const score_dashboard = useMemo(() => Math.round(score('dashboard') * 1000) / 1000, [values]);
  const score_chatbot   = useMemo(() => Math.round(score('chatbot')   * 1000) / 1000, [values]);
  const familiarity_index = useMemo(() => Math.round((score_chatbot - score_dashboard) * 1000) / 1000, [score_chatbot, score_dashboard]);

  const setItem = (tech: TechKey, key: FamKey, v: number) => {
    const nextVals = { ...values, [tech]: { ...(values[tech] ?? {}), [key]: v } };
    setValues(nextVals);
    localStorage.setItem(storageKeyTech(cycle), JSON.stringify({
      values: nextVals, updated_at: new Date().toISOString()
    }));
  };

  const scrollToFirstMissing = () => {
    const first = missingKeys[0];
    if (!first) return;
    if (first === 'imc') setImcShowError(true);
    const el = itemRefs.current[first];
    if (el) {
      requestAnimationFrame(() =>
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      );
    }
  };

  function numOrNull(x: unknown): number | null {
    const n = typeof x === 'number' ? x : Number(x);
    return Number.isFinite(n) ? Math.trunc(n) : null; 
  }

  function buildBatchResponses() {
    const submitted_at = null; // let server COALESCE(..., now())
    const pid = participantId; // from Flow

    // BDLI (values only; mean is computed separately for assignment)
    const bdliRaw = localStorage.getItem(storageKeyBdli(cycle));
    let bdliValues: Record<string, number> | null = null;
    try {
      if (bdliRaw) {
        const parsed = JSON.parse(bdliRaw);
        bdliValues = parsed?.values ?? null;
      }
    } catch { /* ignore */ }

    const bdliItems = bdliValues
      ? Object.entries(bdliValues).map(([k, v]) => ({
          participant_id: pid,
          session_id: null as string | null,
          questionnaire_name: 'BDLI',
          item_key: k,
          value_numeric: numOrNull(v),
          value_text: null as string | null,
          submitted_at,
        }))
      : [];

    // Tech Familiarity (4 items total)
    const tfItems = TECHS.flatMap((t) => ([
      {
        participant_id: pid,
        session_id: null as string | null,
        questionnaire_name: 'TechFam',
        item_key: `${t.key}.use_3m`,
        value_numeric: numOrNull(values[t.key]?.use_3m),
        value_text: null as string | null,
        submitted_at,
      },
      {
        participant_id: pid,
        session_id: null as string | null,
        questionnaire_name: 'TechFam',
        item_key: `${t.key}.capability`,
        value_numeric: numOrNull(values[t.key]?.capability),
        value_text: null as string | null,
        submitted_at,
      },
    ]));

    return [...bdliItems, ...tfItems];
  }

  // BDLI mean (1–5) for stratification
  function computeBdliMean(): number | null {
    const bdliRaw = localStorage.getItem(storageKeyBdli(cycle));
    if (!bdliRaw) return null;
    try {
      const parsed = JSON.parse(bdliRaw);
      const vals: Record<string, number> | undefined = parsed?.values;
      if (!vals) return null;
      const arr = Object.values(vals).map(Number);
      return arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 100) / 100 : null;
    } catch {
      return null;
    }
  }

  // Submit pipeline: IMC → batch responses → assign arm → clear drafts → next()
  const handleSubmit = async () => {
    // 0) page validations
    if (missingKeys.length > 0) {
      setShowErrors(true);
      scrollToFirstMissing();
      return;
    }
/*     if (!allAnswered) {
      setShowErrors(true);
      scrollToFirstMissing();
      return;
    }
    if (!imcChoice) {
      setImcShowError(true);
      imcRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    } */
    if (!participantId) {
      console.warn('No participantId – did consent/registration run?');
      return;
    }

    setSubmitting(true);

    // 1) IMC (always-on here). Screen-out handled centrally after 2 fails.
    const passed = imcChoice === 'banana';
    const { screenedOut } = await recordImc({
      id: IMC_ID,
      page: IMC_PAGE,
      label: 'banana_check',
      passed,
      response: imcChoice
    });
    if (screenedOut) {
      // best-effort: if navigation doesn’t happen, re-enable
      setSubmitting(false);
      return;
    }

    const bdliMean = computeBdliMean();

    // 2) Send batch (BDLI + TechFam)
    try {
      const responses = buildBatchResponses();
      const batchRes = await fetchWithSession(BATCH_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ responses }),
      });
      if (!batchRes.ok) {
        console.warn('Batch failed', batchRes.status, await batchRes.text().catch(() => ''));
        setSubmitting(false);
        return;
      }

      // 3) Ask server to assign (server recomputes from DB)
      const res = await fetchWithSession(ASSIGN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          participant_id: participantId,
          data_lit_score: bdliMean,
          familiarity_dashboard: famRaw('dashboard'),
          familiarity_chatbot:   famRaw('chatbot'),
        }),
      });
      if (!res.ok) {
        console.warn('Assign failed', res.status, await res.text().catch(() => ''));
        setSubmitting(false);
        return;
      }

      const { interface_cond } = await res.json(); // 'dashboard' | 'chatbot'
      const arm = interface_cond === 'chatbot' ? 'chatbot' : 'dashboard';
    
      setAssignment(arm);
      setAdvanceWhenReady(true);

      window.scrollTo({ top: 0, behavior: 'smooth' });

      // 4) Clear local drafts and advance (navigation happens in effect when assignment is set)
      localStorage.removeItem(storageKeyBdli(cycle));
      localStorage.removeItem(storageKeyTech(cycle));

    } catch (e) {
      console.warn('Submit pipeline error', e);
    } finally {
      setSubmitting(false);
    }
  };

  const visuallyDisabled = !allAnswered;

  return (
    <Container maxWidth="md" sx={{ py: 3 }}>
      <Card variant="outlined" sx={{ borderRadius: 3 }}>
        <CardHeader
          title={
            <Stack direction="row" alignItems="baseline" spacing={1}>
              <Typography variant="h5">Technology Familiarity</Typography>
              {cycle && <Typography variant="body2" color="text.secondary">• Cycle {cycle}</Typography>}
            </Stack>
          }
          subheader="Please answer for each technology (Dashboard and Chatbot). Your answers won’t affect payment"
        />
        <Divider />
        <CardContent>
          <Stack spacing={3}>
            {!allAnswered && showErrors && (
              <Alert severity="error" variant="outlined">
                {missingKeys.length === 1
                  ? 'Please answer the highlighted item.'
                  : `Please answer the ${missingKeys.length} highlighted items.`}
              </Alert>
            )}

            {/* --- IMC block (always shown on TechFam) --- */}
            <Card
              ref={registerImcRef}
              variant="outlined"
              sx={{ borderRadius: 2, /* bgcolor: showErrors ? 'rgba(244, 67, 54, 0.06)' : undefined  */}}
            >
              <CardContent sx={{ py: 2 }}>
                <Stack
                  spacing={1.2}
                  sx={{
                    borderRadius: 2,
                    px: 1,
                    py: 0.5,
                    ...(showErrors
                      ? {
                          outline: '2px solid',
                          outlineColor: (theme) => theme.palette.error.main,
                          backgroundColor: 'rgba(244, 67, 54, 0.06)',
                        }
                      : {}),
                  }}
                >
                  <Typography variant="subtitle1" fontWeight={600}>
                    Quick attention check
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    To confirm you’re reading carefully, please select Banana below.
                  </Typography>
                  <FormControl required error={showErrors} component="fieldset" variant="standard">
                    <RadioGroup
                      row
                      name="imc-techfam"
                      value={imcChoice}
                      onChange={(e) => { setImcChoice(e.target.value as ImcChoice); setImcShowError(false); }}
                    >
                      <FormControlLabel value="apple"  control={<Radio />} label={<Typography variant="body2">Apple</Typography>} />
                      <FormControlLabel value="banana" control={<Radio />} label={<Typography variant="body2">Banana</Typography>} />
                      <FormControlLabel value="orange" control={<Radio />} label={<Typography variant="body2">Orange</Typography>} />
                    </RadioGroup>
                    {imcShowError && <FormHelperText>Please select one option.</FormHelperText>}
                  </FormControl>
                </Stack>
              </CardContent>
            </Card>

            <Grid container spacing={3}>
              {TECHS.map((t) => {
                const vUse = values[t.key]?.use_3m;
                const vCap = values[t.key]?.capability;
                const missUse = showErrors && typeof vUse !== 'number';
                const missCap = showErrors && typeof vCap !== 'number';

                return (
                  <Grid key={t.key} size={{ xs: 12 }}>
                    <Card variant="outlined" sx={{ borderRadius: 2 }}>
                      <CardHeader title={<Typography variant="h6">{t.label}</Typography>} sx={{ pb: 0.5 }} />
                      <CardContent>
                        <Stack spacing={2.5}>
                          {/* Use in last 3 months */}
                          <div ref={(el) => (itemRefs.current[`${t.key}.use_3m`] = el)}>
                            <Stack spacing={1} 
                              data-areaid={`q:techfam:${t.key}:use_3m`} 
                              sx={{
                                borderRadius: 2, px: 1, py: 0.5,
                                ...(missUse ? { outline: '2px solid', outlineColor: (theme) => theme.palette.error.main, backgroundColor: 'rgba(244, 67, 54, 0.06)' } : {}),
                            }}>
                              <Typography variant="subtitle1" sx={{ fontWeight: 600, color: missUse ? 'error.main' : undefined }}>
                                {t.label} — use in the last 3 months
                              </Typography>
                              <Typography variant="body2" color="text.secondary">
                                How often have you used {t.label.toLowerCase()} for your work or study?
                              </Typography>
                              <FormControl required error={missUse} component="fieldset" variant="standard">
                                <RadioGroup
                                  row
                                  value={typeof vUse === 'number' ? vUse : ''}
                                  onChange={(e) => setItem(t.key, 'use_3m', Number(e.target.value))}
                                >
                                  {USE_OPTS.map(opt => (
                                    <FormControlLabel key={opt.v} value={opt.v} data-eid={`q:techfam:${t.key}:use_3m:opt:${opt.v}`} control={<Radio />} label={<Typography variant="body2">{opt.label} </Typography>} />
                                  ))}
                                </RadioGroup>
                                {missUse && <FormHelperText>Please select an option.</FormHelperText>}
                              </FormControl>
                            </Stack>
                          </div>

                          {/* Capability */}
                          <div ref={(el) => (itemRefs.current[`${t.key}.capability`] = el)}>
                            <Stack spacing={1} 
                              data-areaid={`q:techfam:${t.key}:capability`} 
                              sx={{
                                borderRadius: 2, px: 1, py: 0.5,
                                ...(missCap ? { outline: '2px solid', outlineColor: (theme) => theme.palette.error.main, backgroundColor: 'rgba(244, 67, 54, 0.06)' } : {}),
                            }}>
                              <Typography variant="subtitle1" sx={{ fontWeight: 600, color: missCap ? 'error.main' : undefined }}>
                                {t.label} — capability
                              </Typography>
                              <Typography variant="body2" color="text.secondary">
                                How would you rate your ability to use {t.label.toLowerCase()} for your typical tasks?
                              </Typography>
                              <FormControl required error={missCap} component="fieldset" variant="standard">
                                <RadioGroup
                                  row
                                  value={typeof vCap === 'number' ? vCap : ''}
                                  onChange={(e) => setItem(t.key, 'capability', Number(e.target.value))}
                                >
                                  {CAP_OPTS.map(opt => (
                                    <FormControlLabel key={opt.v} value={opt.v} data-eid={`q:techfam:${t.key}:capability:opt:${opt.v}`} control={<Radio />} label={<Typography variant="body2">{opt.label}</Typography>} />
                                  ))}
                                </RadioGroup>
                                {missCap && <FormHelperText>Please select an option.</FormHelperText>}
                              </FormControl>
                            </Stack>
                          </div>
                        </Stack>
                      </CardContent>
                    </Card>
                  </Grid>
                );
              })}
            </Grid>

            <Divider />

            <Stack direction="row" justifyContent="space-between" alignItems="center">
              <Typography variant="body2" color="text.secondary">
                {allAnswered
                  ? ``
                  : 'Not all items answered.'}
              </Typography>
              <Box>
                <Button 
                  variant="contained" 
                  size="large" 
                  onClick={handleSubmit}
                  aria-disabled={visuallyDisabled}
                  disabled={ submitting || advanceWhenReady}
                  sx={{
                    opacity: visuallyDisabled ? 0.5 : 1,
                    pointerEvents: 'auto', // keep clickable even when visually disabled
                  }}
                  >
                  {advanceWhenReady ? 'Proceeding…' : submitting ? 'Submitting…' : 'Submit & Continue'}
                </Button>
              </Box>
            </Stack>
          </Stack>
        </CardContent>
      </Card>
    </Container>
  );
}

function storageKeyBdli(cycle?: string) {
  return `survey.bdli.draft.${cycle ?? 'NA'}`;
}
function storageKeyTech(cycle?: string) {
  return `survey.techfam.draft.${cycle ?? 'NA'}`;
}
