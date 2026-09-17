// pages/Reliance.tsx
import * as React from 'react';
import { useState, useMemo, useRef } from 'react';
import { useParams } from 'react-router-dom';
import {
  Alert, Box, Button, Card, CardContent, CardHeader, Container, Divider,
  Stack, Typography, FormHelperText, Grid, RadioGroup, FormControlLabel, Radio
} from '@mui/material';
import { useFlow } from '../context/FlowProvider';
import { apiPath } from '../utils/api';

const BATCH_ENDPOINT = '/questionnaires/responses/batch';
const RELIANCE_QNAME = 'Reliance';

type RelianceKey = 'r1' | 'r2' | 'r3';
type RelianceVals = Partial<Record<RelianceKey, number>>;

const SCALE = [1, 2, 3, 4, 5, 6, 7];

const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;

function interfaceLabel(assign?: 'dashboard' | 'chatbot' | null) {
  if (assign === 'chatbot') return 'chat assistant';
  if (assign === 'dashboard') return 'dashboard';
  return 'system';
}

export default function Reliance({ preview = false }: { preview?: boolean }) {
  const { cycle } = useParams<{ cycle?: string }>();
  const { next, participantId, session, assignment, currentTaskCode, fetchWithSession } = useFlow();

  const label = interfaceLabel(assignment);

  const ITEMS: Array<{ k: RelianceKey; text: string; left: string; center: string; right: string }> = [
    { k: 'r1', text: `A. without checking with anyone or anything else.`, left: 'Very Unlikely', center: 'Neutral', right: 'Very Likely' },
    { k: 'r2', text: `B. but only after asking a colleague for a second opinion.`, left: 'Very Unlikely', center: 'Neutral', right: 'Very Likely' },
    { k: 'r3', text: `C. but only after verifying it using other analytical tools (e.g., spreadsheet/BI).`, left: 'Very Unlikely', center: 'Neutral', right: 'Very Likely' },
  ];

  const [vals, setVals] = useState<RelianceVals>({});
  const [showErrors, setShowErrors] = useState(false);
  const itemRefs = useRef<Record<RelianceKey, HTMLDivElement | null>>({} as any);

  const allAnswered = useMemo(
    () => ITEMS.every(i => typeof vals[i.k] === 'number' && Number.isFinite(vals[i.k])),
    [vals]
  );
  const missingKeys = useMemo(
    () => ITEMS.filter(i => typeof vals[i.k] !== 'number').map(i => i.k),
    [vals]
  );

  const scrollToFirstMissing = () => {
    const first = missingKeys[0];
    if (first && itemRefs.current[first]) {
      itemRefs.current[first]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  const submit = async () => {
    if (!allAnswered) {
      setShowErrors(true);
      scrollToFirstMissing();
      return;
    }

    if (preview) {
      next();
      return;
    }

    const submittedAt = new Date().toISOString();
    const sid = session?.id ?? null;

    const r1 = vals.r1 as number;
    const r2 = vals.r2 as number;
    const r3 = vals.r3 as number;
    const relianceMean = Math.round(mean([r1, r2, r3]) * 100) / 100;

    const responses = [
      { participant_id: participantId, session_id: sid, questionnaire_name: RELIANCE_QNAME, task_code: currentTaskCode, item_key: 'r1', value_numeric: r1, value_text: null, submitted_at: submittedAt },
      { participant_id: participantId, session_id: sid, questionnaire_name: RELIANCE_QNAME, task_code: currentTaskCode, item_key: 'r2', value_numeric: r2, value_text: null, submitted_at: submittedAt },
      { participant_id: participantId, session_id: sid, questionnaire_name: RELIANCE_QNAME, task_code: currentTaskCode, item_key: 'r3', value_numeric: r3, value_text: null, submitted_at: submittedAt },
      // optional aggregate:
      // { participant_id: participantId, session_id: sid, questionnaire_name: RELIANCE_QNAME, item_key: 'reliance_mean', value_numeric: relianceMean, value_text: null, submitted_at: submittedAt },
    ];

    try {
      const res = await fetchWithSession(apiPath(BATCH_ENDPOINT), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ responses }),
      });
      if (!res.ok) console.error('Reliance submit failed', await res.text());
    } catch (e) {
      console.error('Reliance submit error', e);
    }

    next();
  };

  const visuallyDisabled = !allAnswered;

  return (
    <Container maxWidth="md" sx={{ py: 3 }}>
      {preview && (
        <Alert severity="info" sx={{ mb: 2 }} data-tour="rel-intro">
          Preview only — this shows the 1–7 Likert items you’ll answer <em>after</em> each task. Values here are not saved.
        </Alert>
      )}

      <Card variant="outlined" sx={{ borderRadius: 3 }}>
        <CardHeader
          title={
            <Stack direction="row" alignItems="baseline" spacing={1}>
              <Typography variant="h5">Tendency to use</Typography>
              <Typography variant="body2" color="text.secondary">
                {preview ? '(Preview)' : ''}
              </Typography>
              {!preview && cycle && (
                <Typography variant="body2" color="text.secondary">• Task {cycle}</Typography>
              )}
            </Stack>
          }
          subheader="Thinking about the task you just completed, please rate each statement from Very Unlikely (1) to Very Likely (7). Your answers won’t affect payment."
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
            <Typography variant="h6" sx={{ fontWeight: 600 }}>Based on the information I received from the {label}, I would take an action or make a subsequent decision…</Typography>

            <Grid container spacing={3} data-tour="rel-items">
              {ITEMS.map((it, idx) => {
                const v = vals[it.k];
                const answered = typeof v === 'number' && Number.isFinite(v);
                const isMissing = showErrors && !answered;
                const labelId = `rel-label-${it.k}`;
                const helpId = `rel-help-${it.k}`;
                const name = `rel-scale-${it.k}`;

                return (
                  <Grid key={it.k} size={{ xs: 12 }}>
                    <div ref={(el) => (itemRefs.current[it.k] = el)}>
                      <Stack
                        spacing={1.25}
                        sx={{
                          borderRadius: 2,
                          px: 1, py: 0.5,
                          ...(isMissing
                            ? { outline: '2px solid', outlineColor: (theme) => theme.palette.error.main, backgroundColor: 'rgba(244, 67, 54, 0.06)' }
                            : {}),
                        }}
                      >
                        <Stack direction="row" justifyContent="space-between" alignItems="baseline">
                          <Typography id={labelId} variant="subtitle1" sx={{ fontWeight: 600, color: isMissing ? 'error.main' : undefined }}>
                            {it.text}
                          </Typography>
                        </Stack>

                        <Typography id={helpId} variant="body2" color={isMissing ? 'error.main' : 'text.secondary'} sx={{ mt: -0.25, lineHeight: 1.4 }}>
                          Please select one option (1–7).
                        </Typography>

                        {/* Keep the same tour anchor id to avoid breaking tours */}
                        <Box sx={{ px: 1 }} data-areaid={`q:reliance:${it.k}`} data-tour={idx === 0 ? 'rel-one-slider' : undefined}>
                          <RadioGroup
                            row
                            name={name}
                            aria-labelledby={labelId}
                            aria-describedby={helpId}
                            data-eid={`q:reliance:${it.k}:group`} 
                            value={answered ? String(v) : ''}
                            onChange={(_, val) => setVals((p) => ({ ...p, [it.k]: Number(val) }))}
                            sx={{
                              display: 'grid',
                              gridTemplateColumns: 'repeat(7, 1fr)',
                              gap: 0,
                              justifyItems: 'center',
                              alignItems: 'center',
                              mt: 0.5
                            }}
                          >
                            {SCALE.map((val) => (
                              <FormControlLabel
                                key={val}
                                value={String(val)}
                                control={<Radio size="small" />}
                                data-eid={`q:reliance:${it.k}:opt:${val}`} 
                                label={<Typography variant="caption">{val}</Typography>}
                                labelPlacement="bottom"
                                sx={{
                                  m: 0,
                                  '& .MuiFormControlLabel-label': { mt: 0.25 }
                                }}
                              />
                            ))}
                          </RadioGroup>

                          {/* Anchors under the scale */}
                          <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mt: 0.5 }}>
                            <Typography variant="caption" color="text.secondary">{it.left}</Typography>
                            <Typography variant="caption" color="text.secondary" sx={{ transform: 'translateX(-2px)' }}>
                              {it.center}
                            </Typography>
                            <Typography variant="caption" color="text.secondary">{it.right}</Typography>
                          </Stack>

                          {isMissing && (
                            <FormHelperText sx={{ color: 'error.main', mt: 0.5 }}>
                              Please select an option.
                            </FormHelperText>
                          )}
                        </Box>
                      </Stack>
                    </div>
                  </Grid>
                );
              })}
            </Grid>

            <Divider />
            <Box textAlign="right" data-tour="rel-submit">
              <Button
                variant="contained"
                size="large"
                onClick={submit}
                aria-disabled={preview ? false : visuallyDisabled}
                sx={{ opacity: preview ? 1 : (visuallyDisabled ? 0.5 : 1), pointerEvents: 'auto' }}
              >
                Next
              </Button>
            </Box>
          </Stack>
        </CardContent>
      </Card>
    </Container>
  );
}
