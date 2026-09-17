import * as React from 'react';
import { useMemo, useState, useEffect, useRef } from 'react';
import {
  Box, Button, Card, CardContent, CardHeader, Container,
  Divider, Grid, Stack, Typography, Alert, Slider, FormHelperText
} from '@mui/material';
import { useParams } from 'react-router-dom';
import { useFlow } from '../context/FlowProvider';
import { apiPath } from '../utils/api';

const BATCH_ENDPOINT  = '/questionnaires/responses/batch';
const TLX_QNAME = 'NASA-TLX';

type TlxKey =
  | 'mental_demand'
  | 'physical_demand'
  | 'temporal_demand'
  | 'performance'   // 0=Perfect ↔ 100=Failure
  | 'effort'
  | 'frustration';

type TlxItem = {
  key: TlxKey;
  label: string;
  help: string;
  leftAnchor: string;
  rightAnchor: string;
};

const TLX_ITEMS: TlxItem[] = [
  { key: 'mental_demand',   label: 'Mental Demand',   help: 'How mentally demanding was the task?',                     leftAnchor: 'Very Low', rightAnchor: 'Very High' },
  { key: 'physical_demand', label: 'Physical Demand', help: 'How physically demanding was the task?',                  leftAnchor: 'Very Low', rightAnchor: 'Very High' },
  { key: 'temporal_demand', label: 'Temporal Demand', help: 'How hurried or rushed was the pace of the task?',         leftAnchor: 'Very Low', rightAnchor: 'Very High' },
  { key: 'performance',     label: 'Performance',     help: 'How successful were you in accomplishing the task?',      leftAnchor: 'Perfect',  rightAnchor: 'Failure'   },
  { key: 'effort',          label: 'Effort',          help: 'How hard did you have to work to achieve your performance?', leftAnchor: 'Very Low', rightAnchor: 'Very High' },
  { key: 'frustration',     label: 'Frustration',     help: 'How insecure, discouraged, irritated, stressed, annoyed?', leftAnchor: 'Very Low', rightAnchor: 'Very High' },
];

const sliderMarks = [
  { value: 0, label: '0' }, { value: 25, label: '25' }, { value: 50, label: '50' },
  { value: 75, label: '75' }, { value: 100, label: '100' },
];

function clamp(n: number, min: number, max: number) { return Math.max(min, Math.min(max, n)); }
function valueFromPointer(e: React.PointerEvent<HTMLElement>, min = 0, max = 100) {
  const el = e.currentTarget as HTMLElement;
  const rect = el.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const ratio = clamp(x / rect.width, 0, 1);
  return Math.round(min + ratio * (max - min));
}

type TlxValues = Partial<Record<TlxKey, number>>;
function mean(values: number[]) { return values.reduce((a, b) => a + b, 0) / values.length; }

export default function NasaTlx({ preview = false }: { preview?: boolean }) {
  const { cycle } = useParams<{ cycle?: string }>();
  const { next, participantId, session, currentTaskCode, fetchWithSession } = useFlow();

  const [values, setValues] = useState<TlxValues>({});
  const [showErrors, setShowErrors] = useState(false);

  // Refs to scroll to first missing slider
  const itemRefs = useRef<Record<TlxKey, HTMLDivElement | null>>({} as any);

  const allAnswered = useMemo(
    () => TLX_ITEMS.every((i) => typeof values[i.key] === 'number'),
    [values]
  );

  const missingKeys = useMemo(
    () => TLX_ITEMS.filter(i => typeof values[i.key] !== 'number').map(i => i.key),
    [values]
  );

  const rawTlx = useMemo(() => {
    if (!allAnswered) return null;
    const v = TLX_ITEMS.map((i) => values[i.key] as number);
    return Math.round(mean(v) * 10) / 10;
  }, [values, allAnswered]);

  // Draft load
/*   useEffect(() => {
    if (preview) return; // skip loading in preview mode
    const k = storageKey(cycle);
    const draft = localStorage.getItem(k);
    if (draft) {
      try {
        const parsed = JSON.parse(draft);
        if (parsed?.values) setValues(parsed.values as TlxValues);
      } catch
    }
  }, [cycle, preview]); */

  const handleChange = (key: TlxKey, newValue: number) => {
    const nextVals = { ...values, [key]: newValue };
    setValues(nextVals);
    localStorage.setItem(
      storageKey(cycle),
      JSON.stringify({ values: nextVals, updated_at: new Date().toISOString() })
    );
  };

  const scrollToFirstMissing = () => {
    const first = missingKeys[0];
    if (first && itemRefs.current[first]) {
      itemRefs.current[first]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  const handleSubmit = async() => {
    if (!allAnswered) {
      setShowErrors(true);
      scrollToFirstMissing();
      return;
    }

    if (preview) {                                       
      // Optional: remember that user saw the preview
      localStorage.setItem('tlxPreviewSeen', '1');
      next();
      return;
    }

    // timestamps & context
    const submittedAt = new Date().toISOString();
    const startedAt = computeStartedAt(storageKey(cycle));
    const sid = session?.id ?? null;

    // compute numeric values (already validated present)
    const ratings = {
      mental_demand: values.mental_demand as number,
      physical_demand: values.physical_demand as number,
      temporal_demand: values.temporal_demand as number,
      performance:    values.performance    as number,
      effort:         values.effort         as number,
      frustration:    values.frustration    as number,
    };

    // Build batch (server expects rows with item_key + numeric or text)
    const responses = [
      ...Object.entries(ratings).map(([key, val]) => ({
        participant_id: participantId,             // UUID on server
        session_id: sid,                           // include -> server will enforce write token
        questionnaire_name: TLX_QNAME,            // "NASA-TLX"
        task_code: currentTaskCode,                   // e.g., "T1", "T2", etc.
        item_key: key,                             // e.g., "mental_demand"
        value_numeric: val,                        // number
        value_text: null,                          // not used here
        submitted_at: submittedAt,
      })),
/*       {
        participant_id: participantId,
        session_id: sid,
        questionnaire_name: TLX_QNAME,
        item_key: 'raw_tlx',
        value_numeric: rawTlx!,                    // aggregated score
        value_text: null,
        submitted_at: submittedAt,
      }, */
      // (Optional) persist meta as text items if you care:
      // { participant_id: participantId, session_id: sid, questionnaire_name: TLX_QNAME, item_key: 'cycle', value_numeric: null, value_text: String(cycle ?? ''), submitted_at: submittedAt },
      // { participant_id: participantId, session_id: sid, questionnaire_name: TLX_QNAME, item_key: 'started_at', value_numeric: null, value_text: startedAt ?? '', submitted_at: submittedAt },
      // { participant_id: participantId, session_id: sid, questionnaire_name: TLX_QNAME, item_key: 'app_version', value_numeric: null, value_text: String((window as any).__APP_VERSION__ ?? ''), submitted_at: submittedAt },
      // { participant_id: participantId, session_id: sid, questionnaire_name: TLX_QNAME, item_key: 'ua', value_numeric: null, value_text: navigator.userAgent, submitted_at: submittedAt },
    ];

    // Backup locally before sending (so you keep your recovery flow)
/*     const localKey = storageKey(cycle);
    localStorage.setItem(localKey, JSON.stringify({
      values,
      raw_tlx: rawTlx,
      started_at: startedAt,
      submitted_at: submittedAt,
      persisted: true,
    })); */

    try {
      // IMPORTANT: use fetchWithSession so X-Session-Write-Token is added
      const res = await fetchWithSession(apiPath(BATCH_ENDPOINT), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ responses }),
      });
      // Optional: handle non-2xx (422, 403, etc.)
      if (!res.ok) {
        console.error('TLX submit failed', await res.text());
        // You can show a Snackbar/Alert if you want
      }
    } catch (e) {
      console.error('TLX submit error', e);
      // Optionally keep user on page or proceed—your call
    }

    next();
  };

  const STEP = 5;
  const snapToStep = (n: number, min = 0, max = 100, step = STEP) => {
    const clamped = Math.max(min, Math.min(max, n));
    return Math.round(clamped / step) * step;
  };



  const visuallyDisabled = !allAnswered;

  return (
    <Container maxWidth="md" sx={{ py: 3 }}>
      {preview && (                                        // <-- NEW
        <Alert severity="info" sx={{ mb: 2 }} data-tour="tlx-intro">
          Preview only, this page demonstrates the form you’ll complete <em>after</em> each task. Values here are not saved.
        </Alert>
      )}
      <Card variant="outlined" sx={{ borderRadius: 3 }}>
        <CardHeader
          title={
            <Stack direction="row" alignItems="baseline" spacing={1}>
              <Typography variant="h5">NASA-TLX</Typography>
              <Typography variant="body2" color="text.secondary">{preview ? '(Preview)' : ''}  </Typography>
              {!preview && cycle && (                           
                <Typography variant="body2" color="text.secondary">• Task {cycle}</Typography>
              )}
            </Stack>
          }
          subheader="Thinking about your performance of the task you just completed, please rate each item on the 0–100 scale. Click on the line to show the slider, then drag it to choose your answer. Your answers won’t affect your payment."
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

            <Grid container spacing={3} data-tour="tlx-scales">
              {TLX_ITEMS.map((item, idx) => {
                const v = values[item.key];
                const answered = typeof v === 'number' && Number.isFinite(v);
                const isMissing = showErrors && !answered;
                const labelId = `tlx-label-${item.key}`;
                const helpId  = `tlx-help-${item.key}`;

                return (
                  <Grid key={item.key} size={{ xs: 12 }}>
                    <div ref={(el) => (itemRefs.current[item.key] = el)}>
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
                            {item.label}
                          </Typography>
                          <Typography variant="body2" color="text.secondary">
                            {answered ? `${v}` : '—'}
                          </Typography>
                        </Stack>

                        <Typography
                          id={helpId}
                          variant="body2"
                          color={isMissing ? 'error.main' : 'text.secondary'}
                          sx={{ mt: -0.25, lineHeight: 1.4 }}
                        >
                          {item.help}
                        </Typography>

                        <Box sx={{ px: 1 }} data-areaid={`q:tlx:${item.key}`} data-tour={idx === 0 ? 'tlx-one-slider' : undefined}>
                          <Slider
                            data-eid={`q:tlx:${item.key}:slider`}
                            key={`${item.key}-${answered ? 'answered' : 'unset'}`}
                            value={answered ? (v as number) : 50} // hidden-thumb placeholder
                            onPointerDown={(e) => {
                              if (!answered) {
                                const raw = valueFromPointer(e, 0, 100);
                                handleChange(item.key, snapToStep(raw));
                              }
                            }}

                            onChange={(_, val) => handleChange(item.key, snapToStep(val as number))}
                            step={5}
                            min={0}
                            max={100}
                            marks={sliderMarks}
                            track={false}
                            valueLabelDisplay="off"
                            aria-labelledby={labelId}
                            aria-describedby={helpId}
                            sx={{
                              '& .MuiSlider-thumb': { opacity: answered ? 1 : 0 },
                              '& .MuiSlider-rail': { opacity: 0.4 },
                              '& .MuiSlider-mark': { width: 2, height: 2, borderRadius: 1, opacity: 0.8 },
                              '& .MuiSlider-markLabel': { color: 'rgba(255,255,255,0.75)', fontSize: 12, fontWeight: 600 },
                            }}
                          />
                          <Stack direction="row" justifyContent="space-between" sx={{ mt: -1 }}>
                            <Typography variant="caption" color="text.secondary">{item.leftAnchor}</Typography>
                            <Typography variant="caption" color="text.secondary">{item.rightAnchor}</Typography>
                          </Stack>

                          {isMissing && (
                            <FormHelperText sx={{ color: 'error.main', mt: 0.5 }}>
                              Please move the slider to select a value.
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

            <Stack direction="row" justifyContent="space-between" alignItems="center">
              <Typography variant="body2" color="text.secondary">
                {allAnswered !== null ? `` : 'Not all items answered.'}
              </Typography>
              <Stack direction="row" spacing={1} alignItems="center" data-tour="tlx-submit">
                {preview ? (
                  <Button variant="contained" size="large" onClick={handleSubmit}>
                    I’m ready
                  </Button>
                ) : (
                  <Button
                    variant="contained"
                    size="large"
                    onClick={handleSubmit}
                    aria-disabled={!allAnswered}
                    sx={{ opacity: !allAnswered ? 0.5 : 1, pointerEvents: 'auto' }}
                  >
                    Next
                  </Button>
                )}
              </Stack>
            </Stack>
          </Stack>
        </CardContent>
      </Card>
    </Container>
  );
}

/** Helper: stable localStorage key per cycle */
function storageKey(cycle?: string) {
  return `survey.tlx.raw.cycle.${cycle ?? 'NA'}`;
}

/** Helper: best-guess start time if we saved a draft; else null */
function computeStartedAt(key: string): string | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.started_at ?? parsed?.updated_at ?? null;
  } catch {
    return null;
  }
}
