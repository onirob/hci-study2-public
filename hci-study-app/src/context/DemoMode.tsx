// src/context/DemoMode.tsx
import React, { createContext, useContext } from 'react';

const DemoModeCtx = createContext<boolean>(false);
export const useDemoMode = () => useContext(DemoModeCtx);

export function DemoModeProvider({ demo, children }: { demo: boolean; children: React.ReactNode }) {
  return <DemoModeCtx.Provider value={demo}>{children}</DemoModeCtx.Provider>;
}
