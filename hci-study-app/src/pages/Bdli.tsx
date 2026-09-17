// src/pages/Bdli.tsx
import * as React from 'react';
import { useMemo, useEffect, useRef, useState } from 'react';
import {
  Alert, Box, Button, Card, CardContent, CardHeader, Container,
  Divider, Grid, Radio, RadioGroup, FormControlLabel, Stack, Typography,
  FormControl, FormHelperText
} from '@mui/material';
import { useParams } from 'react-router-dom';
import { useFlow } from '../context/FlowProvider';

type BdliKey =
  | 'q1'|'q2'|'q3'|'q4'|'q5'|'q6'|'q7'|'q8'|'q9'|'q10'|'q11'|'q12';

type BdliItem = { key: BdliKey; label: string };

const BDLI_ITEMS: BdliItem[] = [
  { key: 'q1', label: 'Identify appropriate and meaningful connections between multiple types of data sources.' },
  { key: 'q2', label: 'Analyze data sets to inform decision making process.' },
  { key: 'q3', label: 'Manipulate multiple types of visual methods to explore my data.' },
  { key: 'q4', label: 'Assess problems in practical situations using multiple types of data sources.' },
  { key: 'q5', label: 'Find data appropriate for my needs from multiple types of sources.' },
  { key: 'q6', label: 'Discriminate between untrustworthy and trustworthy data from multiple types of data sources.' },
  { key: 'q7', label: 'Access data from multiple types of data sources.' },
  { key: 'q8', label: 'Search through multiple types of data sources.' },
  { key: 'q9', label: 'Manipulate a variety of methods and tools to clean my data.' },
  { key: 'q10', label: 'Create metadata from multiple types of data sources.' },
  { key: 'q11', label: 'Correct errors found in data from multiple types of data sources.' },
  { key: 'q12', label: 'Convert data sources to the most appropriate format required for my needs.' },
];

type BdliValues = Partial<Record<BdliKey, number>>; // 1..5 Likert

const LIKERT = [
  { v: 1, label: 'Strongly disagree' },
  { v: 2, label: '' },
  { v: 3, label: '' },
  { v: 4, label: 'Neutral' },
  { v: 5, label: '' },
  { v: 6, label: '' },
  { v: 7, label: 'Strongly agree' },
];

export default function Bdli() {
  const { next } = useFlow();
  const { cycle } = useParams<{ cycle?: string }>();

  const [values, setValues] = useState<BdliValues>({});
  const [showErrors, setShowErrors] = useState(false);

  // Refs to scroll to first missing item
  const itemRefs = useRef<Record<BdliKey, HTMLDivElement | null>>({} as any);

  // Load draft (if any)
  useEffect(() => {
    const raw = localStorage.getItem(storageKeyBdli(cycle));
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed?.values) setValues(parsed.values as BdliValues);
      } catch {/* ignore */}
    }
  }, [cycle]);

  const allAnswered = useMemo(
    () => BDLI_ITEMS.every(i => typeof values[i.key] === 'number'),
    [values]
  );

  const missingKeys = useMemo(
    () => BDLI_ITEMS.filter(i => typeof values[i.key] !== 'number').map(i => i.key),
    [values]
  );

  const sum = useMemo(() => {
    if (!allAnswered) return null;
    return BDLI_ITEMS.reduce((acc, it) => acc + (values[it.key] as number), 0);
  }, [allAnswered, values]);

  const mean = useMemo(() => (sum == null ? null : Math.round((sum / BDLI_ITEMS.length) * 100) / 100), [sum]);

  const setItem = (k: BdliKey, v: number) => {
    const nextVals = { ...values, [k]: v };
    setValues(nextVals);
    // As soon as the user answers something, we can keep errors visible for others
    localStorage.setItem(storageKeyBdli(cycle), JSON.stringify({
      values: nextVals, updated_at: new Date().toISOString()
    }));
  };

  const scrollToFirstMissing = () => {
    const first = missingKeys[0];
    if (first && itemRefs.current[first]) {
      itemRefs.current[first]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  const onNext = () => {
    if (allAnswered) {
      next();
      return;
    }
    // Reveal errors and move focus to first missing
    setShowErrors(true);
    scrollToFirstMissing();
  };

  // We keep the button visually greyed when incomplete,
  // but clickable to trigger validation/highlighting.
  const visuallyDisabled = !allAnswered;

  return (
    <Container maxWidth="md" sx={{ py: 3 }}>
      <Card variant="outlined" sx={{ borderRadius: 3 }}>
        <CardHeader
          title={
            <Stack direction="row" alignItems="baseline" spacing={1}>
              <Typography variant="h5">Data Literacy</Typography>
              {cycle && <Typography variant="body2" color="text.secondary">• Cycle {cycle}</Typography>}
            </Stack>
          }
          subheader="Please rate your agreement with each statement from 1 (Strongly disagree) to 7 (Strongly agree). Your answers won’t affect payment"
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
            <Typography variant="h6" sx={{ fontWeight: 600 }}>I can…</Typography>
            <Grid container spacing={3}>
              {BDLI_ITEMS.map((item, idx) => {
                const value = values[item.key];
                const isMissing = showErrors && typeof value !== 'number';
                const qNum = idx + 1;
                const qId = `bdli-q-${qNum}`;
                return (
                  <Grid key={item.key} size={{ xs: 12 }}>
                    <div ref={(el) => (itemRefs.current[item.key] = el)}>
                      <Stack spacing={1.25}
                        data-areaid={`q:${item.key}`}   
                        sx={{
                          borderRadius: 2,
                          px: 1,
                          py: 0.5,
                          ...(isMissing
                            ? { outline: '2px solid', outlineColor: (theme) => theme.palette.error.main, backgroundColor: 'rgba(244, 67, 54, 0.06)' }
                            : {}),
                        }}
                      >
                        <Typography
                          id={qId}
                          variant="subtitle1"
                          sx={{ fontWeight: 600, color: isMissing ? 'error.main' : undefined }}
                        >
                          {qNum}. {item.label}
                        </Typography>

                        <FormControl required error={isMissing} component="fieldset" variant="standard">
                          <RadioGroup
                            row
                            value={typeof value === 'number' ? value : ''}
                            onChange={(e) => setItem(item.key, Number(e.target.value))}
                             sx={{
                              display: 'grid',
                              gridTemplateColumns: 'repeat(7, 1fr)',
                              justifyItems: 'center',
                              alignItems: 'center',        
                              mt: 0.5,
                            }}
                          >
                            {LIKERT.map(opt => (
                              <FormControlLabel
                                key={opt.v}
                                value={opt.v}
                                data-eid={`q:${item.key}:opt:${opt.v}`} 
                                control={<Radio size="small" />}
                                label={<Typography variant="caption">{opt.v}</Typography>}
                                labelPlacement="bottom"
                                sx={{ 
                                  m: 0,
                                  '& .MuiFormControlLabel-label': { mt: 0.25 } 
                                }} 
                              />
                            ))}
                          </RadioGroup>
                          <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mt: 0.5 }}>
                            <Typography variant="caption" color="text.secondary">Strongly Disagree</Typography>
                            <Typography variant="caption" color="text.secondary" sx={{ transform: 'translateX(-2px)' }}>
                              Neutral
                            </Typography>
                            <Typography variant="caption" color="text.secondary">Strongly Agree</Typography>
                          </Stack>
                          {isMissing && (
                            <FormHelperText>Please select an option.</FormHelperText>
                          )}
                        </FormControl>
                      </Stack>
                    </div>
                  </Grid>
                );
              })}
            </Grid>

            <Divider />

            <Stack direction="row" justifyContent="space-between" alignItems="center">
              <Typography variant="body2" color="text.secondary">
                {allAnswered != null ? `` : 'Not all items answered.'}
              </Typography>
              <Box>
                <Button
                  variant="contained"
                  size="large"
                  onClick={onNext}
                  aria-disabled={visuallyDisabled}
                  // Visually greyed out when incomplete, but clickable to show errors
                  sx={{
                    opacity: visuallyDisabled ? 0.5 : 1,
                    pointerEvents: 'auto', // keep clickable even when visually disabled
                  }}
                >
                  Next
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
