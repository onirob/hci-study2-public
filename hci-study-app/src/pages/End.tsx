import { navigateStudyExternal, supportEmail } from '../utils/externalActions';
import * as React from 'react';
import {
  Container, Card, CardHeader, CardContent, Typography,
  Button, Stack, Alert, Divider, Tooltip
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import DevicesIcon from '@mui/icons-material/Devices';
import LogoutIcon from '@mui/icons-material/Logout';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CloseIcon from '@mui/icons-material/Close';
import { useNavigate, useLocation } from 'react-router-dom';
import { useFlow } from '../context/FlowProvider';
import type {EndReason} from '../context/FlowProvider'; // ensure types are loaded
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong';


const SUPPORT_EMAIL = supportEmail;

const PROLIFIC_CODES: Partial<Record<EndReason, string>> = {
  // default completion
  completed: import.meta.env.VITE_PROLIFIC_COMPLETED_CODE || '',

  // failed attention check (ask to return submission)
  attention_failed: import.meta.env.VITE_PROLIFIC_ATTENTION_FAILED_CODE || '',

  comprehension_failed: import.meta.env.VITE_PROLIFIC_COMPREHENSION_FAILED_CODE || '',

  // screened out (prescreen mismatch)
  prescreen_excluded: import.meta.env.VITE_PROLIFIC_PRESCREEN_EXCLUDED_CODE || '',

  // do not consent → rejected
  rejected: import.meta.env.VITE_PROLIFIC_REJECTED_CODE || '',
};
const SESSION_ISSUE_RETURN_CODE = import.meta.env.VITE_PROLIFIC_SESSION_ISSUE_CODE || '';


function useQuery() {
  const { search } = useLocation();
  return React.useMemo(() => new URLSearchParams(search), [search]);
}

export default function End() {
  const nav = useNavigate();
  const q = useQuery();
  const { endSummary, devMode } = useFlow();

  const handleEmailClick = (subject?: string) => {
    if (devMode) return; // no-op in dev
    const subjectParam = subject ? `?subject=${encodeURIComponent(subject)}` : '';
    navigateStudyExternal(`mailto:${SUPPORT_EMAIL}${subjectParam}`);
  };

  // Read reason + completion code from URL
  const reason = (q.get('reason') as EndReason) || 'completed';

  const codeFromQuery = q.get('code') || '';
  const completionCode =
    codeFromQuery || PROLIFIC_CODES[reason] || '';


  const bonuses = (endSummary?.bonuses_detail ?? []).filter(Boolean);
  const totalMinor = bonuses.reduce((sum, b) => sum + (b.amount_minor || 0), 0);
  const total = (totalMinor / 100).toFixed(2);

  const [copied, setCopied] = React.useState(false);
  const copyCode = async () => {
    if (!completionCode) return;
    try {
      await navigator.clipboard.writeText(completionCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {/* ignore */}
  };

  // Go to Prolific with code
  const goToProlific = (code?: string) => {
    if (devMode) return; // no-op in dev

    if (code) {
      navigateStudyExternal(`https://app.prolific.com/submissions/complete?cc=${encodeURIComponent(code)}`);
    } else {
      // Fallback: just send them to their submissions page
      navigateStudyExternal('https://app.prolific.com/submissions');
    }
  };

  // Config per reason
  const cfg = React.useMemo(() => {
    switch (reason) {
      case 'completed':
        return {
          color: 'success' as const,
          icon: <CheckCircleIcon />,
          title: 'All done, thank you!',
          body: (
            <>
              <Typography color="text.secondary">
                Your responses and task data have been recorded.
              </Typography>

              {completionCode ? (
                <>
                  <Divider sx={{ my: 2 }} />
                  <Typography variant="subtitle2">Completion code</Typography>
                  <Typography
                    variant="h5"
                    sx={{ fontFamily: 'monospace', letterSpacing: 1 }}
                  >
                    {completionCode}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    You can click the button below to be redirected to Prolific.
                    If something goes wrong, submit this code manually on Prolific.
                  </Typography>
                </>
              ) : null}

              <>
                <Divider sx={{ my: 2 }} />
                <Typography variant="subtitle2">Performance bonus summary</Typography>
                {bonuses.length > 0 ? (
                  <>
                    <Stack component="ul" spacing={0.5} sx={{ m: 0, pl: 2 }}>
                      {bonuses.map((b, idx) => (
                        <li key={idx}>
                          <Typography variant="body2">
                            <strong>{b.task_code}</strong> — £{(b.amount_minor / 100).toFixed(2)}{' '}
                            <Typography
                              component="span"
                              variant="body2"
                              color="text.secondary"
                            >
                              ({b.reason})
                            </Typography>
                          </Typography>
                        </li>
                      ))}
                    </Stack>
                    <Typography variant="body2" sx={{ mt: 0.5 }}>
                      <strong>Total bonus:</strong> £{total}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      Bonuses are paid on Prolific after your submission is reviewed and approved.
                    </Typography>
                  </>
                ) : (
                  <Typography variant="body2" color="text.secondary">
                    No performance bonus was earned based on the study rules.
                  </Typography>
                )}
              </>
            </>
          ),

          primary: completionCode
            ? {
                label: 'Return to Prolific',
                onClick: () => goToProlific(completionCode),
                startIcon: <LogoutIcon />,
              }
            : {
                label: 'Return to Prolific',
                onClick: () => goToProlific(),
                startIcon: <LogoutIcon />,
              },

          // secondary: copy code (nice backup)
          secondary: completionCode
            ? {
                label: copied ? 'Copied!' : 'Copy code',
                onClick: copyCode,
                startIcon: <ContentCopyIcon />,
              }
            : undefined,

          alert: null as React.ReactNode,
        };

      case 'session_lost':
        return {
          color: 'error' as const,
          icon: <ErrorOutlineIcon />,
          title: 'Session interrupted',
          body: (
            <>
              <Typography color="text.secondary">
                The page was reloaded or closed. This study allows one uninterrupted run, so your session has been
                closed and cannot be resumed.
              </Typography>

              <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
                As specified in the study instructions, this session cannot be restarted. Please return your
                submission on Prolific using the code below.
              </Typography>

              <Typography variant="subtitle2" sx={{ mt: 2 }}>
                Prolific return code
              </Typography>
              <Typography
                variant="h6"
                sx={{ fontFamily: 'monospace', letterSpacing: 1 }}
              >
                {SESSION_ISSUE_RETURN_CODE}
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                Click the button below to open the Prolific completion page with this code pre-filled. Prolific
                will ask you to <strong>return</strong> the submission, as per the study rules.
              </Typography>
            </>
          ),
          primary: {
            label: 'Return submission on Prolific',
            onClick: () => {
              navigateStudyExternal(`https://app.prolific.com/submissions/complete?cc=${encodeURIComponent(SESSION_ISSUE_RETURN_CODE)}`);
            },
            startIcon: <LogoutIcon />,
          },
          secondary: {
            label: 'Contact support',
            onClick: () => handleEmailClick('Study help'),
          },
          alert: (
            <Alert severity="error" variant="outlined">
              For data quality reasons, re-entry isn’t permitted. If this was unintentional, contact the research team.
            </Alert>
          ),
        };

      case 'session_invalid':
        return {
          color: 'error' as const,
          icon: <ErrorOutlineIcon />,
          title: 'Session expired or invalid',
          body: (
            <>
              <Typography color="text.secondary">
                Your session token is no longer valid. This usually happens after a refresh, using multiple tabs,
                or staying idle for too long.
              </Typography>

              <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
                This session cannot be resumed. Please return your submission on Prolific using the code below.
              </Typography>

              <Typography variant="subtitle2" sx={{ mt: 2 }}>
                Prolific return code
              </Typography>
              <Typography
                variant="h6"
                sx={{ fontFamily: 'monospace', letterSpacing: 1 }}
              >
                {SESSION_ISSUE_RETURN_CODE}
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                Click the button below to open the Prolific completion page with this code pre-filled. Prolific
                will ask you to <strong>return</strong> the submission.
              </Typography>
            </>
          ),
          primary: {
            label: 'Return submission on Prolific',
            onClick: () => {
              navigateStudyExternal(`https://app.prolific.com/submissions/complete?cc=${encodeURIComponent(SESSION_ISSUE_RETURN_CODE)}`);
            },
            startIcon: <LogoutIcon />,
          },
          secondary: {
            label: 'Contact support',
            onClick: () => handleEmailClick('Session invalid'),
          },
          alert: null as React.ReactNode,
        };

      case 'device_mismatch':
        return {
          color: 'error' as const,
          icon: <DevicesIcon />,
          title: 'Device change detected',
          body: (
            <>
              <Typography color="text.secondary">
                Please complete the study on the same device you started with. A device change was detected, so
                your session has been closed and cannot be resumed.
              </Typography>

              <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
                Please return your submission on Prolific using the code below, as required by the study rules.
              </Typography>

              <Typography variant="subtitle2" sx={{ mt: 2 }}>
                Prolific return code
              </Typography>
              <Typography
                variant="h6"
                sx={{ fontFamily: 'monospace', letterSpacing: 1 }}
              >
                {SESSION_ISSUE_RETURN_CODE}
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                Click the button below to open the Prolific completion page with this code pre-filled. Prolific
                will ask you to <strong>return</strong> the submission.
              </Typography>
            </>
          ),
          primary: {
            label: 'Return submission on Prolific',
            onClick: () => {
              navigateStudyExternal(`https://app.prolific.com/submissions/complete?cc=${encodeURIComponent(SESSION_ISSUE_RETURN_CODE)}`);
            },
            startIcon: <LogoutIcon />,
          },
          secondary: {
            label: 'Contact support',
            onClick: () => handleEmailClick('Device mismatch'),
          },
          alert: null as React.ReactNode,
        };

      case 'already_in_progress':
        return {
          color: 'warning' as const,
          icon: <WarningAmberIcon />,
          title: 'Run already in progress',
          body: (
            <Typography color="text.secondary">
              Our records show you already started the study. For data quality, only one run is allowed. If you
              believe this is an error, please contact the research team via Prolific.
            </Typography>
          ),
          primary: {
            label: 'Close tab',
            onClick: () => window.close(),
            startIcon: <CloseIcon />,
          },
          secondary: {
            label: 'Contact support',
            onClick: () =>
              (navigateStudyExternal(`mailto:${SUPPORT_EMAIL}?subject=Already%20in%20progress`)),
          },
          alert: null as React.ReactNode,
        };

      case 'rejected':
        return {
          color: 'error' as const,
          icon: <LogoutIcon />,
          title: 'You are not eligible to participate',
          body: (
            <Typography color="text.secondary">
              Based on the eligibility criteria, you cannot take part in this study. Thank you for your interest.
            </Typography>
          ),
          primary: { label: 'Close tab', onClick: () => window.close(), startIcon: <CloseIcon /> },
          secondary: { label: 'Back to start', onClick: () => nav('/') },
          alert: null as React.ReactNode,
        };
      case 'attention_failed':
        return {
          color: 'error' as const,
          icon: <WarningAmberIcon />,
          title: 'Attention check not passed',
          body: (
            <>
              <Typography color="text.secondary">
                Unfortunately, the attention check was not passed. Per protocol, the session has ended.
              </Typography>

              {completionCode && (
                <>
                  <Divider sx={{ my: 2 }} />
                  <Typography variant="subtitle2">Prolific return code</Typography>
                  <Typography
                    variant="h6"
                    sx={{ fontFamily: 'monospace', letterSpacing: 1 }}
                  >
                    {completionCode}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Please click the button below to return your submission on Prolific.
                    You can also use this code manually if needed.
                  </Typography>
                </>
              )}
            </>
          ),
          primary: {
            label: 'Return submission on Prolific',
            onClick: () => goToProlific(completionCode),
            startIcon: <LogoutIcon />,
          },
          secondary: {
            label: 'Contact support',
            onClick: () =>
              (navigateStudyExternal(`mailto:${SUPPORT_EMAIL}?subject=Attention%20check`)),
          },
          alert: null as React.ReactNode,
        };
      case 'comprehension_failed':
        return {
          color: 'error' as const,
          icon: <WarningAmberIcon />,
          title: 'Comprehension check not passed',
          body: (
            <>
              <Typography color="text.secondary">
                Unfortunately, the comprehension check was not passed. Per protocol, the session has ended.
              </Typography>

              {completionCode && (
                <>
                  <Divider sx={{ my: 2 }} />
                  <Typography variant="subtitle2">Prolific return code</Typography>
                  <Typography
                    variant="h6"
                    sx={{ fontFamily: 'monospace', letterSpacing: 1 }}
                  >
                    {completionCode}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Please click the button below to return your submission on Prolific.
                    You can also use this code manually if needed.
                  </Typography>
                </>
              )}
            </>
          ),
          primary: {
            label: 'Return submission on Prolific',
            onClick: () => goToProlific(completionCode),
            startIcon: <LogoutIcon />,
          },
          secondary: {
            label: 'Contact support',
            onClick: () =>
              (navigateStudyExternal(`mailto:${SUPPORT_EMAIL}?subject=Comprehension%20check`)),
          },
          alert: null as React.ReactNode,
        };

      case 'prescreen_excluded':
        return {
          color: 'error' as const,
          icon: <WarningAmberIcon />,
          title: 'Thanks, this study isn’t a fit',
          body: (
            <>
              <Typography color="text.secondary">
                Based on the brief confirmation questions at the start, your current industry,
                role and responsibilities don’t match the target manufacturing-management
                profile for this study. To avoid wasting your time and to keep data quality
                high, the session ends here.
              </Typography>

              {completionCode && (
                <>
                  <Divider sx={{ my: 2 }} />
                  <Typography variant="subtitle2">Prolific return code</Typography>
                  <Typography
                    variant="h6"
                    sx={{ fontFamily: 'monospace', letterSpacing: 1 }}
                  >
                    {completionCode}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Please click the button below to return your submission on Prolific.
                    You can also use this code manually if needed.
                  </Typography>
                </>
              )}
            </>
          ),
          primary: {
            label: 'Return submission on Prolific',
            onClick: () => goToProlific(completionCode),
            startIcon: <LogoutIcon />,
          },
          secondary: {
            label: 'Contact support',
            onClick: () =>
              (navigateStudyExternal(`mailto:${SUPPORT_EMAIL}?subject=Prescreen%20exclusion`)),
          },
          alert: null as React.ReactNode,
        };

      case 'quit':
      default:
        return {
          color: 'warning' as const,
          icon: <LogoutIcon />,
          title: 'Session ended',
          body: (
            <Typography color="text.secondary">
              Your session has been closed. Partial data may be discarded per protocol.
            </Typography>
          ),
          primary: { label: 'Close tab', onClick: () => window.close(), startIcon: <CloseIcon /> },
          secondary: { label: 'Back to start', onClick: () => nav('/') },
          alert: null as React.ReactNode,
        };
    }
  }, [reason, completionCode, nav]);

  return (
    <Container maxWidth="sm" sx={{ py: 6 }}>
      <Card
        variant="outlined"
        sx={{
          borderRadius: 3,
          overflow: 'hidden',
          borderColor: (t) =>
            cfg.color === 'success' ? t.palette.success.light :
            cfg.color === 'warning' ? t.palette.warning.light :
            t.palette.error.light,
        }}
      >
        <CardHeader
          avatar={
            <Stack
              alignItems="center"
              justifyContent="center"
              sx={{
                width: 40, height: 40, borderRadius: '50%',
                bgcolor: (t) =>
                  cfg.color === 'success' ? t.palette.success.light :
                  cfg.color === 'warning' ? t.palette.warning.light :
                  t.palette.error.light,
                color: (t) =>
                  cfg.color === 'success' ? t.palette.success.contrastText :
                  cfg.color === 'warning' ? t.palette.warning.contrastText :
                  t.palette.error.contrastText,
              }}
            >
              {cfg.icon}
            </Stack>
          }
          title={
            <Typography variant="h5" component="h1">
              {cfg.title}
            </Typography>
          }
        />
        <CardContent>
          <Stack spacing={2}>
            {cfg.alert}
            {cfg.body}
            <Stack direction="row" spacing={1.5} sx={{ pt: 1 }}>
              {cfg.primary ? (
                <Button
                  onClick={cfg.primary.onClick}
                  variant={reason === 'completed' && completionCode ? 'contained' : 'outlined'}
                  startIcon={cfg.primary.startIcon}
                >
                  {cfg.primary.label}
                </Button>
              ) : null}
              {cfg.secondary ? (
                <Tooltip title={reason !== 'completed' ? 'Re-entry may be blocked by the study rules.' : ''}>
                  <span>
                    <Button onClick={cfg.secondary.onClick} variant="text" disabled={false}>
                      {cfg.secondary.label}
                    </Button>
                  </span>
                </Tooltip>
              ) : null}
            </Stack>
          </Stack>
        </CardContent>
      </Card>
      {/* Tiny footer hint */}
      <Typography
        variant="caption"
        color="text.disabled"
        sx={{ display: 'block', textAlign: 'center', mt: 2 }}
      >
        For issues about your Prolific submission or payment, please contact us via Prolific’s
        messaging system. For technical or ethical concerns about this study, you
        can also{' '}
        <Button
          variant="text"
          size="small"
          onClick={() => handleEmailClick()}
          disabled={devMode} // optional visual hint
        >
          email the researchers
        </Button>
        .
      </Typography>

    </Container>
  );
}
