// src/components/Freeze.tsx
import React from 'react';
import { Box } from '@mui/material';

export default function Freeze({ children }: { children: React.ReactNode }) {
  return (
    <Box sx={{ pointerEvents: 'none', userSelect: 'none', opacity: 1 }}>
      {children}
    </Box>
  );
}
