// src/pages/PreScreenCheck.tsx
import * as React from 'react';
import { useRef, useState, useMemo } from 'react';
import {
  Alert, Box, Button, Card, CardContent, CardHeader, Container, Divider,
  FormControl, FormControlLabel, FormHelperText, FormGroup, Radio, RadioGroup,
  Checkbox, Stack, Typography
} from '@mui/material';
import { useFlow } from '../context/FlowProvider';
import { apiPath } from '../utils/api';

const BATCH_ENDPOINT = apiPath('/questionnaires/responses/batch');
const SUMMARY_ENDPOINT = apiPath('/prescreen/summary');
const QNAME = 'PrescreenStart';

// --- Types ---
type SingleItem = {
  key: string;
  prompt: string;           // exact Prolific wording
  options: string[];        // exact labels/order from Prolific
  required?: boolean;
  type?: 'single';          // default
  helper?: string;
};

type MultiItem = {
  key: string;
  prompt: string;
  options: string[];
  required?: boolean;
  type: 'multi';
  minSelect?: number;       // default 1 if required
  helper?: string;
};

type Item = SingleItem | MultiItem;

// --- Screeners (+ company size as analysis control) ---
const ITEMS: Item[] = [
  {
    key: 'industry_role',
    type: 'single',
    required: true,
    prompt: 'Industry Role. Which of the following best describes your role at work?:',
    options: [
      'Upper Management',
      'Trained Professional',
      'Middle Management',
      'Skilled Laborer',
      'Junior Management',
      'Consultant',
      'Administrative Staff',
      'Temporary Employee',
      'Support Staff',
      'Researcher',
      'Student',
      'Self-employed/Partner',
      'Other'
    ]
  },
  {
    key: 'industry',
    type: 'single',
    required: true,
    prompt: 'Industry. Which of the following categories best describes the industry you primarily work in (regardless of your actual position)?',
    options: [
      'Construction',
      'Finance and Insurance',
      'Education',
      'Food Processing and Service',
      'Manufacturing',
      'Medical/Healthcare',
      'Computer and Electronics Manufacturing',
      'Automotive',
      'Mining',
      'Oil and Gas',
      'Nuclear Power',
      'Utilities',
      'Other Manufacturing',
      'Engineering',
      'Transportation and Warehousing',
      'Telecommunications',
      'Pharmaceuticals / Bio-tech'
    ]
  },
  {
    key: 'decision_responsibilities',
    type: 'multi',
    required: true,
    minSelect: 1,
    prompt: 'Decision-making responsibilities. What decision-making responsibilities do you have at work?',
    helper: 'Select all that apply. “None” is mutually exclusive with the other options.',
    options: [
      'Accounts/finance',
      'Business strategy',
      'Customer/client',
      'Hiring',
      'Marketing/sales/advertising',
      'Operations/production',
      'People management',
      'Research/development',
      'Supply chain/logistics',
      'Other',
      'None',
      'Fleet management'
    ]
  },
  // Analysis control (not a gate)
  {
    key: 'company_size',
    type: 'single',
    required: true,
    prompt: 'Approximately how many employees does your company have?',
    options: [
      'Micro (1–9)',
      'Small (10–49)',
      'Medium (50–249)',
      'Large (250-999)',
      'Enterprise (1000+)'
    ]
  }
];

export default function PreScreenCheck() {
  const { next, fetchWithSession, participantId, session, endAndExit } = useFlow();
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [submitting, setSubmitting] = useState(false);
  const [showError, setShowError] = useState(false);

  const itemRefs = useRef<Record<string, HTMLDivElement | null>>({} as any);

  const allRequiredAnswered = useMemo(() => {
    return ITEMS.every(it => {
      if (!it.required) return true;
      const v = answers[it.key];
      if ((it.type ?? 'single') === 'single') return !!v && String(v).length > 0;
      const arr = (v as string[]) ?? [];
      return arr.length > 0 && ((it as MultiItem).minSelect ? arr.length >= ((it as MultiItem).minSelect ?? 1) : true);
    });
  }, [answers]);

  const missingKeys = useMemo(() => {
    const miss: string[] = [];
    for (const it of ITEMS) {
      if (!it.required) continue;
      const v = answers[it.key];
      if ((it.type ?? 'single') === 'single') {
        if (!v) miss.push(it.key);
      } else {
        const arr = (v as string[]) ?? [];
        const min = (it as MultiItem).minSelect ?? 1;
        if (arr.length < min) miss.push(it.key);
      }
    }
    return miss;
  }, [answers]);

  const scrollToFirstMissing = () => {
    const first = missingKeys[0];
    if (first && itemRefs.current[first]) {
      itemRefs.current[first]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  // multi-select toggle with "None" exclusivity
  const toggleMulti = (key: string, value: string) => {
    setAnswers(prev => {
      const current = new Set<string>(Array.isArray(prev[key]) ? (prev[key] as string[]) : []);
      if (current.has(value)) {
        current.delete(value);
      } else {
        if (value === 'None') current.clear();
        current.add(value);
        if (value !== 'None' && current.has('None')) current.delete('None');
      }
      return { ...prev, [key]: Array.from(current) };
    });
  };

  function buildBatchResponses() {
    const submitted_at = null; // let server COALESCE(..., now())
    return ITEMS.map((it) => {
      const v = answers[it.key];
      const text = Array.isArray(v) ? v.join(' | ') : (v ?? null);
      return {
        participant_id: participantId,
        session_id: session?.id ?? null,
        task_code: null as string | null,
        questionnaire_name: QNAME,
        item_key: it.key,
        value_numeric: null as number | null,
        value_text: text as string | null,
        submitted_at,
      };
    });
  }

  const handleSubmit = async () => {
    // 0) validations
    if (missingKeys.length > 0) {
      setShowError(true);
      scrollToFirstMissing();
      return;
    }
    if (!participantId) {
      console.warn('No participantId – did consent/registration run?');
      return;
    }

    setSubmitting(true);
    try {
      // 1) Send batch (PrescreenStart)
      const responses = buildBatchResponses();
      const batchRes = await fetchWithSession(BATCH_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ responses }),
      });
      if (!batchRes.ok) {
        console.warn('[PreScreen] Batch failed', batchRes.status, await batchRes.text().catch(() => ''));
        setSubmitting(false);
        return;
      }

      // 2) Ask server to compute & persist prescreen label (pass/review/exclude)
        const sumRes = await fetchWithSession(SUMMARY_ENDPOINT, { method: 'POST' });
        
        // Case A: server enforces early stop with 403
        if (sumRes.status === 403) {
        let code: string | undefined;
        try {
            const body = await sumRes.json();
            code = body?.detail?.code ?? body?.code; // FastAPI puts it under 'detail'
        } catch {}
        if (code === 'prescreen_excluded') {
            await endAndExit?.('prescreen_excluded', { finalStatus: 'rejected' });
            return;
        }
        // Fallback: treat any other 403 as session issue (optional)
        await endAndExit?.('session_invalid');
        return;
        }

        // Case B: server returned 200 but label says exclude (defensive fallback)
        if (sumRes.ok) {
        let payload: any = null;
        try { payload = await sumRes.json(); } catch {}
        if (payload?.prescreen_label === 'exclude') {
            await endAndExit?.('prescreen_excluded', { finalStatus: 'rejected' });
            return;
        }
        } else {
        console.warn('[PreScreen] Summary failed', sumRes.status, await sumRes.text().catch(() => ''));
        }

      // 3) Always proceed (no gating in UI)
      window.scrollTo({ top: 0, behavior: 'smooth' });
      next();

    } catch (e) {
      console.warn('[PreScreen] submit pipeline error', e);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Container maxWidth="md" sx={{ py: 3 }}>
      <Card variant="outlined" sx={{ borderRadius: 3 }}>
        <CardHeader
          title={<Typography variant="h5">Quick eligibility confirmation</Typography>}
          subheader="These questions match the filters used on Prolific and help us confirm data quality. Your answers won’t affect your base payment. If your situation has changed, that’s okay, please answer truthfully."
        />
        <Divider />
        <CardContent>
          <Stack spacing={3}>
            {showError && missingKeys.length > 0 && (
              <Alert severity="error" variant="outlined">
                Please answer all required items.
              </Alert>
            )}

            {ITEMS.map((it) => {
              const type = it.type ?? 'single';
              const value = answers[it.key];

              return (
                <div key={it.key} ref={(el) => (itemRefs.current[it.key] = el)}>
                  <Stack spacing={1}>
                    <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                      {it.prompt}{it.required ? ' *' : ''}
                    </Typography>

                    <FormControl
                      required={!!it.required}
                      error={showError && it.required && (
                        (type === 'single' && !value) ||
                        (type === 'multi' && ((value as string[] | undefined)?.length ?? 0) < ((it as MultiItem).minSelect ?? 1))
                      )}
                    >
                      {type === 'single' ? (
                        <RadioGroup
                          value={typeof value === 'string' ? value : ''}
                          onChange={(e) => setAnswers(a => ({ ...a, [it.key]: e.target.value }))}
                          data-areaid={`q:${it.key}`}  
                        >
                          {it.options.map(opt => (
                            <FormControlLabel
                              key={opt}
                              value={opt}
                              control={<Radio />}
                              label={<Typography variant="body2">{opt}</Typography>}
                            />
                          ))}
                        </RadioGroup>
                      ) : (
                        <FormGroup data-areaid={`q:${it.key}`}>
                          {it.options.map(opt => {
                            const arr = Array.isArray(value) ? (value as string[]) : [];
                            const checked = arr.includes(opt);
                            return (
                              <FormControlLabel
                                key={opt}
                                control={
                                  <Checkbox
                                    checked={checked}
                                    onChange={() => toggleMulti(it.key, opt)}
                                  />
                                }
                                label={<Typography variant="body2">{opt}</Typography>}
                              />
                            );
                          })}
                        </FormGroup>
                      )}

                      {it.helper && <FormHelperText>{it.helper}</FormHelperText>}
                      {showError && it.required && (
                        (type === 'single' && !value) ||
                        (type === 'multi' && ((value as string[] | undefined)?.length ?? 0) < ((it as MultiItem).minSelect ?? 1))
                      ) && (
                        <FormHelperText>Please select {it.type === 'multi' ? `at least ${(it as MultiItem).minSelect ?? 1}` : 'an option'}.</FormHelperText>
                      )}
                    </FormControl>
                  </Stack>
                  <Divider sx={{ my: 2 }} />
                </div>
              );
            })}

            <Box sx={{ display: 'flex', gap: 2 }}>
              <Button
                variant="contained"
                size="large"
                onClick={handleSubmit}
                disabled={submitting || !allRequiredAnswered}
              >
                {submitting ? 'Submitting…' : 'Continue'}
              </Button>

{/*               <Button
                variant="text"
                disabled={submitting}
                onClick={() => { setAnswers({}); setShowError(false); }}
              >
                Reset
              </Button> */}
            </Box>
          </Stack>
        </CardContent>
      </Card>
    </Container>
  );
}
