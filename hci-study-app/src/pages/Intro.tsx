import { navigateStudyExternal, supportEmail, externalActionsEnabled } from '../utils/externalActions';
// src/pages/Intro.tsx
import * as React from 'react';
import {
  Box, Button, Card, CardContent, CardHeader, Checkbox, Container,
  FormControlLabel, Typography, Alert, Stack, Link, CircularProgress, 
} from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import LogoutIcon from '@mui/icons-material/Logout';
import { useFlow } from '../context/FlowProvider';
import { apiPath } from '../utils/api';
import { isNonDesktop } from '../utils/device_check';

const CONSENT_VERSION = 'v1-2025-10-01';
const PROLIFIC_DECLINE_CODE = import.meta.env.VITE_PROLIFIC_REJECTED_CODE || ''; 

export default function Intro() {
  const { ready, error, prolific, devMode, next, setParticipantId, startSession, endAndExit } = useFlow();
  const [agree, setAgree] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [localError, setLocalError] = React.useState<string | undefined>(undefined);
  const [declined, setDeclined] = React.useState(false);

  const blockedDevice = isNonDesktop();
  
  if (blockedDevice) {
    // HARD BLOCK: no consent buttons at all.
    return (
      <Container maxWidth="sm" sx={{ mt: 6, mb: 6 }}>
        <Card>
          <CardContent>
            <Typography variant="h5" gutterBottom>
              This study must be done on a computer
            </Typography>
            <Typography variant="body2" paragraph>
              It looks like you are using a phone or tablet. 
              Please open this study link again on a laptop or desktop computer to participate.
              If you think this is an error, please contact the research team via Prolific.
            </Typography>
            <Typography variant="body2">
              You can now close this tab. Nothing has been recorded.
            </Typography>
          </CardContent>
        </Card>
      </Container>
    );
  } 

  // single-flight guard (blocks re-entry within same tick/frame)
  const inFlight = React.useRef(false);

  // can submit if ready, have prolific params, and agree
  const canSubmit = ready && !!prolific?.prolific_pid && agree;

  async function handleConsent(e?: React.MouseEvent | React.KeyboardEvent) {
    e?.preventDefault?.();

    if (submitting || inFlight.current) return;
    inFlight.current = true;

    if (!prolific?.prolific_pid) {
      setLocalError('Missing Prolific parameters. Please start from Prolific.');
      inFlight.current = false;
      return;
    }

    setSubmitting(true);
    setLocalError(undefined);

    // per-request idempotency token
    const idem = (globalThis.crypto as any)?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;

    try {
      const res = await fetch(apiPath('/participants/consent_register'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Idempotency-Key': idem,
        },
        credentials: 'include',
        body: JSON.stringify({
          prolific_pid: prolific.prolific_pid,
          prolific_study_id: prolific.prolific_study_id,
          prolific_session_id: prolific.prolific_session_id,
          consent_version: CONSENT_VERSION,
        }),
      });

      // Try to parse JSON payload (may be empty)
      let code: string | undefined;
      let data: any;
      try {
        const cloned = await res.clone().json();
        code = cloned?.detail?.code || cloned?.code;
        data = cloned;
      } catch { /* non-JSON or empty body */ }

      if (!res.ok) {
        if (res.status === 403) {
          // Prefer a header (survives many proxy/CORS oddities), fallback to JSON
          let parsed: any = undefined;
          try { parsed = await res.clone().json(); } catch {}
          const headerCode = res.headers.get('x-policy-code') ?? res.headers.get('X-Policy-Code');
          const code = headerCode ?? parsed?.detail?.code ?? parsed?.code;

          // Route all terminal policies to End
          switch (code) {
            case 'completed':
              await endAndExit('completed', { finalStatus: 'completed' });
              return;
            case 'already_in_progress':
              await endAndExit('already_in_progress');
              return;
            case 'rejected':
              await endAndExit('rejected', { finalStatus: 'rejected' });
              return;
            case 'timed_out':
              await endAndExit('timed_out'); // or map to a specific FinalStatus if you want
              return;
            default:
              await endAndExit('session_invalid');
              return;
          }
        }

        // Non-policy failures → show retry (don’t forfeit)
        setLocalError(`Consent failed (${res.status}). Please retry in a moment.`);
        setSubmitting(false);
        inFlight.current = false;
        return;
      }

      // Success
      const pid = data?.participant_id ?? (await res.json())?.participant_id;
      if (!pid) throw new Error('No participant_id returned by consent endpoint.');

      sessionStorage.setItem('participant_id', pid);
      setParticipantId(pid);

      try {
        await startSession(pid); // ensure token is actually set
      } catch (e: any) {
        // Only forfeit for policy errors; otherwise allow retry
        const scode = e?.code as string | undefined;
        if (scode === 'session_already_started' || scode === 'device_mismatch') {
          await endAndExit('session_invalid');
          return;
        }
        setLocalError('Service is temporarily unavailable. Please try again.');
        setSubmitting(false);
        inFlight.current = false;
        return;
      }

      next(); // proceed (keep submitting/inFlight true to avoid re-entry until navigation)

    } catch (e: any) {
      setLocalError(e?.message ?? 'Network error while submitting consent.');
      setSubmitting(false);
      inFlight.current = false;
    }
  }

  async function handleDecline(e?: React.MouseEvent | React.KeyboardEvent) {
    e?.preventDefault?.();
    if (submitting) return;

    if (!prolific?.prolific_pid) {
      // Dev fallback: show local declined screen
      setDeclined(true);
      return;
    }

    setSubmitting(true);
    setLocalError(undefined);
    const idem = (globalThis.crypto as any)?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;

    try {
      const res = await fetch(apiPath('/participants/consent_decline'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Idempotency-Key': idem,
        },
        credentials: 'include',
        body: JSON.stringify({
          prolific_pid: prolific.prolific_pid,
          prolific_study_id: prolific.prolific_study_id,
          prolific_session_id: prolific.prolific_session_id,
          consent_version: CONSENT_VERSION,
          ineligible_reason: 'declined_consent',
        }),
      });

      if (!res.ok) {
        if (res.status === 403) {
          let parsed: any = undefined;
          try { parsed = await res.clone().json(); } catch {}
          const headerCode = res.headers.get('x-policy-code') ?? res.headers.get('X-Policy-Code');
          const code = headerCode ?? parsed?.detail?.code ?? parsed?.code;

          switch (code) {
            case 'completed':            await endAndExit('completed', { finalStatus: 'completed' }); return;
            case 'already_in_progress':  await endAndExit('already_in_progress'); return;
            case 'rejected':             // already rejected → just show declined UI
              setDeclined(true); setSubmitting(false); return;
            case 'timed_out':            await endAndExit('session_invalid', { finalStatus: 'timed_out' }); return;
            default:                     setLocalError(`Decline failed (${res.status}). Please close the tab.`); break;
          }
        } else {
          setLocalError(`Decline failed (${res.status}). Please close the tab.`);
        }
        setSubmitting(false);
        return;
      }

      // Persisted OK
      setDeclined(true);
    } catch (err: any) {
      setLocalError(err?.message ?? 'Network error while declining.');
    } finally {
      setSubmitting(false);
    }
  }

  // Prevent Enter/Space repeat while submitting
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (submitting && (e.key === 'Enter' || e.key === ' ')) e.preventDefault();
  };

  if (declined) {
    const fromProlific = !!prolific?.prolific_pid;

    return (
      <Container maxWidth="md" sx={{ py: 6 }}>
        <Card variant="outlined">
          <CardHeader title="You chose not to participate" />
          <CardContent>
            <Typography paragraph>
              No problem—thanks for considering it.
            </Typography>

            {fromProlific ? (
              <>
                <Typography paragraph>
                  Please return your submission in Prolific
                  using the code below.
                </Typography>

                <Typography variant="subtitle2">Prolific return code</Typography>
                <Typography
                  variant="h6"
                  sx={{ fontFamily: 'monospace', letterSpacing: 1, mb: 1 }}
                >
                  {PROLIFIC_DECLINE_CODE}
                </Typography>

                <Typography variant="body2" color="text.secondary" paragraph>
                  Click the button below to open Prolific’s return page. If that doesn’t work,
                  copy and paste this code manually on Prolific.
                </Typography>

                <Stack direction="row" spacing={1.5} sx={{ mt: 1 }}>
                  <Button
                    variant="contained"
                    onClick={() => {
                      navigateStudyExternal(`https://app.prolific.com/submissions/complete?cc=${encodeURIComponent(
                          PROLIFIC_DECLINE_CODE,
                        )}`);
                    }}
                    startIcon={<LogoutIcon />}
                  >
                    Return submission on Prolific
                  </Button>

                  <Button
                    variant="outlined"
                    onClick={() => navigator.clipboard.writeText(PROLIFIC_DECLINE_CODE)}
                    startIcon={<ContentCopyIcon />}
                  >
                    Copy code
                  </Button>
                </Stack>
              </>
            ) : (
              <Typography paragraph>
                You can now close this tab.
              </Typography>
            )}

            {devMode && (
              <Alert severity="info" sx={{ mt: 2 }}>
                Dev mode: in production this screen sends participants to Prolific with the
                appropriate return code.
              </Alert>
            )}

            <Button variant="text" sx={{ mt: 2 }} onClick={() => setDeclined(false)}>
              Go back
            </Button>
          </CardContent>
        </Card>
      </Container>
    );
  }


  return (
    <Container maxWidth="md" sx={{ py: 6 }}>
      <Card variant="outlined">
        <CardHeader title="Study introduction & informed consent" />
        <CardContent>
          <Stack spacing={3}>
            {!externalActionsEnabled && (
              <Alert severity="info">
                Public platform copy for local exploration. The study materials below are retained
                for reference; this is not an invitation to participate and no payment is offered.
                External completion and contact actions are disabled.
              </Alert>
            )}
            {/* Gate conditions */}
            {!ready && (
              <Alert severity="info" icon={<CircularProgress size={16} />}>
                Initializing… (loading your participant session)
              </Alert>
            )}
            {error && <Alert severity="error">{error}</Alert>}
            {devMode && prolific && (
              <Alert severity="warning">
                Dev mode • Using fake Prolific params: <strong>{prolific.prolific_pid}</strong>
              </Alert>
            )}

            {/* Brief description */}
            <Box>
              <Typography variant="h6" gutterBottom>
                What this study is about
              </Typography>
              <Typography paragraph sx={{ mb: 2 }}>
                You’ll complete decision-making tasks in a simulated factory using an interface.
                We measure task performance and your experience. We’re evaluating the interfaces, not you.
              </Typography>
              <Typography component="div">
                {/* Your participation */}
                <Typography variant="h6" gutterBottom>Your participation</Typography>
                <Box component="ul" sx={{ mt: 0, pl: 3, '& li': { mb: 1.0, lineHeight: 1.7 } }}>
                  <li><strong>Time:</strong> ~26 minutes in a single session. Prolific automatically times out submissions that exceed the platform time limit.</li>
                  <li><strong>Requirements:</strong> desktop/laptop; Chrome/Edge/Firefox; stable internet. Don’t refresh, use the back button, or close the tab (inactivity may time out).</li>
                  <li><strong>Data collected:</strong> task answers, clicks and timings, attention-check results, and brief questionnaires; basic device/browser data.</li>
                  <li><strong>Withdrawal:</strong> you may return the study on Prolific at any time without penalty. If you don’t finish, base pay/bonuses may not apply.</li>
                </Box>
                <Box component="ul" sx={{ mt: 0, pl: 3, '& li': { mb: 1 } }}>
                  <li><strong>Payment</strong></li>
                  <Box component="ul" sx={{ mt: 0.5, pl: 3 }}>
                    <li><em>Base pay:</em> £12 for completing all parts as instructed.</li>
                    <li><em>Timing:</em> paid via Prolific after submission review and approval.</li>
                    <li><em>Eligibility:</em> complete all sections in one session by using the provided tool in each task, and pass a small number of attention checks.</li>
                  </Box>

                  <li><strong>Performance bonus</strong></li>
                  <Box component="ul" sx={{ mt: 0, pl: 3, '& li': { mb: 1 } }}>
                    <li>
                      <em>Basis:</em> accuracy on tasks (no speed incentive).
                    </li>
                    <li>
                      <em>Amounts:</em> up to a total of £1.5 (shown at the end if you qualify).
                    </li>
                    <li>
                      <em>Eligibility & timing:</em> awarded only if you complete the study; paid as a Prolific bonus after approval.
                    </li>
                  </Box>
                </Box>
              </Typography>
              <Alert severity="info" icon={false} sx={{ mb: 2 }}>
                <strong>TL;DR:</strong> ~26 min in one sitting · Desktop browser only · Don’t refresh/back/close · Use provided tools in each task
              </Alert>
              <Typography variant="body2" color="text.secondary">
                By consenting, you agree to take part in this university study. Your data are stored
                securely and analyzed in aggregate; no identifying information will be published.
              </Typography>
            </Box>

            {/* Consent text box */}
            <Box
              sx={{
                border: '1px solid',
                borderColor: 'divider',
                borderRadius: 1,
                p: 2,
                maxHeight: 200,
                overflow: 'auto',
                backgroundColor: 'background.default',
              }}
              aria-label="Consent information"
            >
              <Typography variant="subtitle2" gutterBottom>
                Consent statement
              </Typography>
              <Typography variant="body2" paragraph sx={{ whiteSpace: 'pre-line' }}>
                • I am 18+ and voluntarily agree to participate.
                {'\n'}• I understand what the study involves and can withdraw at any time without providing a reason.
                {'\n'}• I consent to the collection of study data for research purposes.
                {'\n'}• Data will be stored securely and reported only in aggregate, without identifying me.
                {'\n'}• For questions, I can contact the research team via the address provided in the Prolific study page.
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Data processing conforms to the study’s information sheet and GDPR guidance.
                Data Controller: University of Pisa (Lungarno Pacinotti 43, Pisa).
                Data Protection Officer: see the original study information sheet (contact omitted from this public copy).
                You may exercise your rights (access, rectification, erasure, restriction/objection, portability) and lodge a complaint with the Italian Data Protection Authority (www.garanteprivacy.it).
              </Typography>
            </Box>

            {/* Controls */}
            <FormControlLabel
              control={
                <Checkbox
                  checked={agree}
                  onChange={(e) => setAgree(e.target.checked)}
                  name="consent"
                />
              }
              label="I have read the above and I consent to participate."
            />
            {localError && <Alert severity="error">{localError}</Alert>}

            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <Button
                variant="contained"
                onClick={handleConsent}
                onKeyDown={onKeyDown}
                disabled={!canSubmit || submitting}
                aria-busy={submitting ? 'true' : undefined}
              >
                {submitting ? 'Submitting…' : 'Agree and continue'}
              </Button>
              <Button
                variant="text"
                color="inherit"
                onClick={handleDecline}
                disabled={submitting}
              >
                I do not consent
              </Button>
              <Box sx={{ flex: 1 }} />
              <Typography variant="caption" sx={{ alignSelf: 'center' }}>
                Need help? <Link component="button" onClick={() => navigateStudyExternal(`mailto:${supportEmail}?subject=Consent%20help`)}>Contact the researchers</Link>
              </Typography>
            </Stack>
          </Stack>
        </CardContent>
      </Card>
    </Container>
  );
}
