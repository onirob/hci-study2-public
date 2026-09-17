// src/components/TimerDisplay.tsx
import { Typography } from '@mui/material';
import { useTimer } from '../context/TimerProvider';

export default function TimerDisplay() {
  const { secondsLeft } = useTimer();

  if (secondsLeft === null) return null;        // untimed section → nothing

  const mm = String(Math.floor(secondsLeft / 60)).padStart(2, '0');
  const ss = String(secondsLeft % 60).padStart(2, '0');

  return (
    <Typography
      variant="subtitle2"
      sx={{ fontVariantNumeric: 'tabular-nums', ml: 2 }}
    >
      {mm}:{ss}
    </Typography>
  );
}
