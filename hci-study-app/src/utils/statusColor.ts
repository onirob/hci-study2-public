import { green, amber, grey } from '@mui/material/colors';

/* export const statusColor = {
  on:   green[500],
  standby: amber[500],
  offline: grey[500],
} satisfies Record<'on' | 'standby' | 'offline', string>; */


export const statusColor: Record<string, string> = {
  // New backend-aligned states
  working: '#A5D6A7',   // green-ish
  idle:    '#FFF59D',   // yellow-ish
  offline: '#E0E0E0',   // gray
  alarm:   '#FFAB91',   // orange/red

  // Back-compat with older mock UIs
  on:      '#A5D6A7',
  standby: '#FFF59D',
};