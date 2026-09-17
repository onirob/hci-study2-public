// src/pages/Imc.tsx
import * as React from 'react';
import { useState, useRef, useMemo } from 'react';
import {
  Box, Button, Card, CardContent, CardHeader, Container,
  Divider, FormControl, FormControlLabel, FormHelperText, Radio, RadioGroup,
  Stack, Typography, TextField,
  Alert
} from '@mui/material';
import { useParams } from 'react-router-dom';
import { useFlow } from '../context/FlowProvider';
import { apiPath } from '../utils/api';

import tlxImg from '../assets/nasa-tlx.png';

type Variant = 'imc1' | 'imc2' | 'tools' | 'cc_tlx_perf' | 'cc_rel'; 

const BATCH_ENDPOINT = '/questionnaires/responses/batch';
const TOOLS_QNAME = 'External Tools';

function interfaceLabel(assign?: 'dashboard' | 'chatbot' | null) {
  if (assign === 'chatbot') return 'chat assistant';
  if (assign === 'dashboard') return 'dashboard';
  return 'system';
}

export default function Imc() {
  const { recordImc, next, fetchWithSession, participantId, session, assignment } = useFlow();
  const { which } = useParams<{ which?: string }>();

  const interface_label = interfaceLabel(assignment);

  const variant: Variant = useMemo(() => {
    const w = (which || '').toLowerCase();
    if (w === 'imc1' || w === '1') return 'imc1';
    if (w === 'imc2' || w === '2') return 'imc2';
    if (w === 'tools' || w === '3') return 'tools';
    if (w === 'tlxperf' || w === 'cc_tlx_perf' || w === 'cc1') return 'cc_tlx_perf';
    if (w === 'cc_rel' || w === 'ccrel' || w === 'reliancecc') return 'cc_rel';
    return 'imc1';
  }, [which]);

  // Unique id/label per variant (ensures one count per distinct check)
  const IMC_ID   = variant === 'imc1' ? 'imc_fam_1'
                : variant === 'imc2' ? 'imc_fam_2'
                : variant === 'cc_tlx_perf' ? 'cc_tlx_perf_1'
                : variant === 'cc_rel' ? 'cc_rel_1'
                :                      'tool_use_1';

  const IMC_PAGE = variant === 'tools' ? 'ImcTools'
                : variant === 'cc_tlx_perf' ? 'CcTlxPerformance'
                : variant === 'cc_rel' ? 'CcReliance'
                : 'ImcFam';

  const LABEL    = variant === 'imc1' ? 'bogus_statement_likert'
                : variant === 'imc2' ? 'triangle_check'
                : variant === 'cc_tlx_perf' ? 'tlx_performance_direction'
                : variant === 'cc_rel' ? 'reliance_comprehension'
                :                      'external_tools';
   

  const [choice, setChoice] = useState<string>('');     // for imc1/imc2
  const [toolUsed, setToolUsed] = useState<'yes'|'no'|''>(''); 
  const [explain, setExplain] = useState('');           
  const [submitting, setSubmitting] = useState(false);
  const [showError, setShowError] = useState(false);
  const [textError, setTextError] = useState(false);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [ccPerf, setCcPerf] = useState<string>('');      // one MC answer
  const [ccPerfErr, setCcPerfErr] = useState(false);
  const [ccCorrectionShown, setCcCorrectionShown] = useState(false);
  const [ccRel, setCcRel] = useState<string>('');
  const [ccRelErr, setCcRelErr] = useState(false);

  const [ccRelCorrectionShown, setCcRelCorrectionShown] = useState(false);

  const [ccPerfAttempt, setCcPerfAttempt] = useState<1|2>(1);
  const [ccRelAttempt, setCcRelAttempt] = useState<1|2>(1);

  
  React.useEffect(() => {
    setCcPerf('');
    setCcPerfErr(false);
    setCcCorrectionShown(false);
    setCcPerfAttempt(1);
    
    setCcRelAttempt(1);
    setCcRel('');
    setCcRelErr(false);
    setCcRelCorrectionShown(false);
  }, [variant]);



  const title =
    variant === 'tools' ? 'Resource use during the session'
  : (variant === 'cc_tlx_perf' || variant === 'cc_rel') ? 'Quick comprehension check'
  : 'Quick check';
  const subheader =
    (variant === 'cc_tlx_perf' || variant === 'cc_rel')
    ? 'Please answer the multiple-choice question below. You can re-read the recap on this page.'
      : variant === 'imc1'
      ? 'Please read and answer the statement below.'
      : variant === 'imc2'
      ? 'Please read and answer the item below.'
      : 'People sometimes use calculators, notes, or other resources in online tasks. Your answers won’t affect payment; we’re studying typical behavior.'; 

  const prompt =
    variant === 'cc_tlx_perf'
    ? 'NASA-TLX item scale direction'
      : variant === 'cc_rel'
      ? 'Tendency to use'
      : variant === 'imc1'
      ? '“I can become invisible and breathe underwater without any equipment.”'
      : variant === 'imc2'
      ? 'To confirm you’re reading carefully, please select Triangle below.'
      : 'Did you make use of any external tool as a help during the execution of the tasks (e.g., calculator, note-taking)?'; 

  const handleSubmit = async () => {
    if (variant === 'cc_tlx_perf') {

      if (!ccPerf) {
        setCcPerfErr(true);
        cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }

      const passed = (ccPerf === 'higher_worse');
      const evId = ccPerfAttempt === 1 ? `${IMC_ID}_a1` : `${IMC_ID}_a2`;

      setSubmitting(true);
      try {
        const { screenedOut } = await recordImc({
          id: evId,
          page: IMC_PAGE,
          label: LABEL,
          passed,
          response: ccPerf,
        });

        if (screenedOut) return;

        if (passed) {
          next();
        } else if (ccPerfAttempt === 1) {
          setCcCorrectionShown(true);
          setCcPerfAttempt(2);
          setCcPerf(''); // force an actual second choice
        } else { }
      } finally {
        setSubmitting(false);
      }
      return;
    }

    if (variant === 'cc_rel') {

      if (!ccRel) {
        setCcRelErr(true);
        cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }

      // Correct = both
      const passed = (ccRel === 'both');
      const evId = ccRelAttempt === 1 ? `${IMC_ID}_a1` : `${IMC_ID}_a2`;

      setSubmitting(true);
      try {
        const { screenedOut } = await recordImc({
          id: evId,
          page: IMC_PAGE,
          label: LABEL,
          passed,
          response: ccRel,
        });

        if (screenedOut) return;

        if (passed) {
          next();
        } else if (ccRelAttempt === 1) {
          setCcRelCorrectionShown(true);
          setCcRelAttempt(2);
          setCcRel(''); // force an actual second choice
        } else { }
      } finally {
        setSubmitting(false);
      }
      return;
    }



    // ---- Branch by variant ----
    if (variant === 'tools') {
      // POST to questionnaires batch (NOT /attention)
      setSubmitting(true);
      try {
        const wc = (explain.trim().match(/\S+/g) || []).length;
        const veryShort = wc < 12;

        const responses = [
          {
            participant_id: participantId,           
            session_id: session?.id ?? null,    
            questionnaire_name: TOOLS_QNAME,
            item_key: 'tools_used',
            value_numeric: toolUsed === 'yes' ? 1 : 0,
          },
          {
            participant_id: participantId,           
            session_id: session?.id ?? null, 
            questionnaire_name: TOOLS_QNAME,
            item_key: toolUsed === 'yes' ? 'explain_why' : 'explain_no',
            value_text: explain.trim(),
          },
          {
            participant_id: participantId,
            session_id: session?.id ?? null,
            questionnaire_name: TOOLS_QNAME,
            item_key: 'explain_word_count',
            value_numeric: wc,
          },
          {
            participant_id: participantId,
            session_id: session?.id ?? null,
            questionnaire_name: TOOLS_QNAME,
            item_key: 'explain_very_short',
            value_numeric: veryShort ? 1 : 0,
          },
        ];

        const res = await fetchWithSession(apiPath(BATCH_ENDPOINT), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ responses }),
        });

        if (!res.ok) {
          console.error('Tools survey submit failed', await res.text());
          // optional: show a snackbar here
        }
        next();
      } catch (e) {
        console.error('Tools survey submit error', e);
        next(); // or keep user here, your call
      } finally {
        setSubmitting(false);
      }
      return; // IMPORTANT: do not fall through to recordImc
    }

    // ---- imc1 / imc2 keep using recordImc ----
    setSubmitting(true);
    try {
      const passed =
        variant === 'imc1'
          ? (choice === 'd' || choice === 'sd')
          : (choice === 'triangle');

      const { screenedOut } = await recordImc({
        id: IMC_ID,
        page: IMC_PAGE,
        label: LABEL,
        passed,
        response:  choice,
      });

      if (!screenedOut) next();
    } finally {
      setSubmitting(false);
    }
  };
  
  

  return (
    <Container maxWidth="md" sx={{ py: 3 }}>
      <Card ref={cardRef} variant="outlined" sx={{ borderRadius: 3 }}>
        <CardHeader
          title={<Typography variant="h5">{title}</Typography>}
          subheader={subheader}
        />
        <Divider />
        <CardContent>
          <Stack spacing={2.5}>
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
              {prompt}
            </Typography>

            {variant === 'cc_tlx_perf' && (
              <Stack spacing={2.25}>
                <Box sx={{ p: 2, borderRadius: 2, border: '1px solid', borderColor: 'divider', bgcolor: 'action.hover' }}>
                  <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 0.5 }}>
                    NASA-TLX recap (please read before answering)
                  </Typography>
                  <Typography variant="body2">
                    You will rate <b>six</b> aspects of your experience. Each item uses the same 0–100 slider.
                    There are <b>no right or wrong answers</b>; we care about your subjective experience.
                    For each item, move the slider toward the end that best matches how you felt during the task.
                    <br/><br/>
                    <b>Most items work in the intuitive direction</b> (higher = more of that feeling).
                    For example, if the task was very mentally demanding, you would move the <b>Mental Demand</b> slider toward 100.
                    <br/><br/>
                    <b>Only the “Performance” item is different.</b> It is reversed:
                    <b>lower</b> values mean you felt very successful (0 = <b>Perfect</b>),
                    while <b>higher</b> values mean you felt you did poorly (100 = <b>Failure</b>).

                  </Typography>

                  {/* optional TLX image (you’ll point src to your existing asset) */}
                  <Box
                    component="img"
                    src= {tlxImg}
                    alt="NASA-TLX example (Performance scale)"
                    loading="lazy"
                    sx={{
                      mt: 1.25,
                      width: '100%',
                      maxWidth: 600,
                      borderRadius: 1.5,
                      border: '1px solid',
                      borderColor: 'divider',
                      display: 'block',
                      mx: 'auto',
                    }}
                  />
                </Box>

                {ccCorrectionShown && (
                  <Alert severity="warning" variant="outlined">
                    <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                      Please re-read the recap and try again.
                    </Typography>
                    <Typography variant="body2">
                      Attempt <b>2 of 2</b>.
                    </Typography>
                  </Alert>
                )}

                <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                  Which statement correctly describes the NASA-TLX “Performance” scale?
                </Typography>

                <FormControl required error={ccPerfErr} component="fieldset" variant="standard" data-areaid="q:cc:tlx_performance_direction" >
                  <RadioGroup
                    name="cc-tlx-perf"
                    value={ccPerf}
                    onChange={(e) => { setCcPerf(e.target.value); setCcPerfErr(false); }}
                    data-eid="q:cc:tlx_performance_direction:group"
                  >
                    <FormControlLabel value="same_as_others" control={<Radio />} label={<Typography variant="body2">Same direction as the other TLX items</Typography>} />
                    <FormControlLabel value="direction_irrelevant" control={<Radio />} label={<Typography variant="body2">The direction doesn’t matter</Typography>} />                   
                    <FormControlLabel value="higher_better" control={<Radio />} label={<Typography variant="body2">Higher values mean better performance (closer to Perfect)</Typography>} />
                    <FormControlLabel value="higher_worse" control={<Radio />} label={<Typography variant="body2">Higher values mean worse performance (closer to Failure)</Typography>} />                   
                    <FormControlLabel value="not_sure" control={<Radio />} label={<Typography variant="body2">I’m not sure</Typography>} />
                  </RadioGroup>
                  {ccPerfErr && <FormHelperText>Please select one option.</FormHelperText>}
                </FormControl>
              </Stack>
            )}

            {variant === 'cc_rel' && (
              <Stack spacing={2.25}>
                <Box sx={{ p: 2, borderRadius: 2, border: '1px solid', borderColor: 'divider', bgcolor: 'action.hover' }}>
                  <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 0.5 }}>
                    Tendency to use recap (please read before answering)
                  </Typography>
                  <Typography variant="body2">
                    In this questionnaire, <b>Tendency to use</b> refers to whether you would take action based on what the {interface_label} tells you,
                    <b> without</b> additional checks, or <b>after</b> taking some additional step to verify the information.
                    <br /><br />
                    The items are:
                    <br />
                    <b>A.</b> “… without checking with anyone or anything else.”
                    <br />
                    <b>B.</b> “… but only after asking a colleague for a second opinion.”
                    <br />
                    <b>C.</b> “… but only after verifying it using other analytical tools.”
                    <br />
                    Each item has to be valued on a scale from Very Unlikely to Very Likely (1-7).
                  </Typography>
                </Box>

                {ccRelCorrectionShown && (
                  <Alert severity="warning" variant="outlined">
                    <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                      Please re-read the recap and try again.
                    </Typography>
                    <Typography variant="body2">
                      Attempt <b>2 of 2</b>.
                    </Typography>
                  </Alert>
                )}

                <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                  You receive information from the {interface_label} and need to make a decision based on it. In the "Tendency to use" questionnaire above, two items describe “taking action only after an additional step”. 
                  <br />
                  Which of the following statements best describes this situation altogether?
                </Typography>

                <FormControl required error={ccRelErr} component="fieldset" variant="standard" data-areaid="q:cc:reliance_comprehension">
                  <RadioGroup
                    name="cc-rel"
                    value={ccRel}
                    onChange={(e) => { setCcRel(e.target.value); setCcRelErr(false); }}
                    data-eid="q:cc:reliance_comprehension:group"
                  >
                    <FormControlLabel value="act" control={<Radio />} label={<Typography variant="body2">No additional step (act immediately).</Typography>} />
                    <FormControlLabel value="both" control={<Radio />} label={<Typography variant="body2">Either asking a colleague or using other tools depending on the situation. </Typography>} />
                    <FormControlLabel value="tools" control={<Radio />} label={<Typography variant="body2">Only after verifying it using other analytical tools.</Typography>} />
                    <FormControlLabel value="colleague" control={<Radio />} label={<Typography variant="body2">Only after asking a colleague for a second opinion.</Typography>} />
                  </RadioGroup>
                  {ccRelErr && <FormHelperText>Please select one option.</FormHelperText>}
                </FormControl>
              </Stack>
            )}





            {/* Minor helper text for imc1 */}
            {variant === 'imc1' && (
              <Typography variant="body2" color="text.secondary">
                Choose how much you agree with the statement.
              </Typography>
            )}

            {variant === 'imc1' && (
              <FormControl required error={showError} component="fieldset" variant="standard" data-areaid="q:imc:likert">
                <RadioGroup
                  row
                  name="imc-fam-likert"
                  value={choice}
                  onChange={(e) => { setChoice(e.target.value); setShowError(false); }}
                  data-eid="q:imc:likert:group"
                >
                  <FormControlLabel value="sd" control={<Radio />} label={<Typography variant="body2">Strongly disagree</Typography>} />
                  <FormControlLabel value="d"  control={<Radio />} label={<Typography variant="body2">Disagree</Typography>} />
                  <FormControlLabel value="a"  control={<Radio />} label={<Typography variant="body2">Agree</Typography>} />
                  <FormControlLabel value="sa" control={<Radio />} label={<Typography variant="body2">Strongly agree</Typography>} />
                </RadioGroup>
                {showError && <FormHelperText>Please select one option.</FormHelperText>}
              </FormControl>
            )}

            {variant === 'imc2' && (
              <FormControl required error={showError} component="fieldset" variant="standard" data-areaid="q:imc:shape">
                <RadioGroup
                  row
                  name="imc-fam-shape"
                  value={choice}
                  onChange={(e) => { setChoice(e.target.value); setShowError(false); }}
                  data-eid="q:imc:shape:group"
                >
                  <FormControlLabel value="circle"   control={<Radio />} label={<Typography variant="body2">Circle</Typography>} />
                  <FormControlLabel value="triangle" control={<Radio />} label={<Typography variant="body2">Triangle</Typography>} />
                  <FormControlLabel value="square"   control={<Radio />} label={<Typography variant="body2">Square</Typography>} />
                </RadioGroup>
                {showError && <FormHelperText>Please select one option.</FormHelperText>}
              </FormControl>
            )}

            {variant === 'tools' && (
              <Stack spacing={2}>
                <Stack spacing={1.25}
                  sx={{
                    borderRadius: 2,
                    px: 1,
                    py: 0.5,
                    ...(showError
                      ? { outline: '2px solid', outlineColor: (theme) => theme.palette.error.main, backgroundColor: 'rgba(244, 67, 54, 0.06)' }
                      : {}),
                  }}
                >
                <FormControl required error={showError} component="fieldset" variant="standard" data-areaid="q:external_tools:used">
                  <RadioGroup
                    row
                    name="tool-used"
                    value={toolUsed}
                    onChange={(e) => { setToolUsed(e.target.value as 'yes'|'no'); setShowError(false); }}
                    data-eid="q:external_tools:used:group"
                  >
                    <FormControlLabel value="yes" control={<Radio />} label={<Typography variant="body2">Yes</Typography>} />
                    <FormControlLabel value="no"  control={<Radio />} label={<Typography variant="body2">No</Typography>} />
                  </RadioGroup>
                  {showError && <FormHelperText>Please select one option.</FormHelperText>}
                </FormControl>
              </Stack>
                <Typography variant="body2" color="text.secondary">
                  {toolUsed === 'yes'
                    ? 'If you used any resource, please tell us briefly when/why (e.g., “I used a calculator in T2 to check totals”).'
                    : 'If you didn’t use any resource, was it because you thought it was prohibited? Would you have used them if explicitly allowed?'}
                </Typography>
                  <TextField
                    required
                    multiline
                    minRows={3}
                    placeholder={toolUsed === 'yes' ? '2–3 sentences are helpful…' : 'A brief note is helpful…'}
                    value={explain}
                    onChange={(e) => { setExplain(e.target.value); if (textError) setTextError(false); }}
                    inputProps={{ maxLength: 1000 }}
                    error={textError}
                    helperText={
                      textError
                        ? 'Please write a brief explanation.'
                        : ''
                    }
                  />

                <Typography variant="caption" color="text.secondary">
                  Your payment isn’t affected by your answers.
                </Typography>
              </Stack>
            )}

            <Box sx={{ mt: 1 }}>
              <Button
                variant="contained"
                size="large"
                onClick={handleSubmit}
                disabled={
                  submitting
                }
              >
                {(submitting ? 'Submitting…' : 'Submit & Continue')}
              </Button>
            </Box>
          </Stack>
        </CardContent>
      </Card>
    </Container>
  );
}
