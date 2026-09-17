// main.tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { TimerProvider } from './context/TimerProvider';
import { CssBaseline, ThemeProvider, createTheme } from '@mui/material';

const dark = createTheme({ palette: { mode: 'dark' } });

ReactDOM.createRoot(document.getElementById('root')!).render(
  <ThemeProvider theme={dark}>
    <CssBaseline />
    <TimerProvider>
      <App />      {/* FlowProvider will now live *inside* App */}
    </TimerProvider>
  </ThemeProvider>,
);
