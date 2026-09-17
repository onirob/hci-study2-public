// src/flow.ts
export type InterfaceAssignment = 'dashboard' | 'chatbot';

type BaseSection = { path: string; seconds: number };

export type Section =
  | ({ id: 'intro' }            & BaseSection)
  | ({ id: 'precheck' }         & BaseSection)
  | ({ id: 'bdli' }             & BaseSection)
  | ({ id: 'techfam' }          & BaseSection)
  | ({ id: 'fam' }              & BaseSection)
  | ({ id: 'tlx_preview' }      & BaseSection)
  | ({ id: 'cc_tlx_perf' }      & BaseSection)
  | ({ id: 'cc_rel' }      & BaseSection)
  | ({ id: 'imc1' }             & BaseSection)
  | ({ id: 'imc2' }             & BaseSection)
  | ({ id: 'tools' }            & BaseSection)
  | ({ id: 'reliance_preview' } & BaseSection)
  // Task sections carry the server task_code + complexity
  | ({ id: 'task'; cycle: number; task_code: string; complexity: number } & BaseSection)
  | ({ id: 'tlx'; cycle: number }      & BaseSection)
  | ({ id: 'reliance'; cycle: number } & BaseSection)
  | ({ id: 'end' }                     & BaseSection);

// ────────────────────────────────────────────────────────────
// Single source of truth for tasks (shared by BOTH interfaces)
// Update codes/seconds/complexity to match the backend.
// ────────────────────────────────────────────────────────────
type TaskDef = { code: string; seconds: number; complexity: number };

const SHARED_TASK_PLAN: TaskDef[] = [
  { code: 'T1', seconds: 180,  complexity: 3 },  // check always these match the task time requirements
  { code: 'T2', seconds: 360, complexity: 9 },
  { code: 'T3', seconds: 600, complexity: 31 },
];

export function getTaskDef(cycle: number): TaskDef {
  // cycles are 1-indexed; wrap if more cycles than entries
  return SHARED_TASK_PLAN[(cycle - 1) % SHARED_TASK_PLAN.length];
}

// ────────────────────────────────────────────────────────────
// Pre-assignment (always available)
// ────────────────────────────────────────────────────────────
export function buildPreFlow(): Section[] {
  return [
    { id: 'intro',    path: '/intro',                 seconds: 0 },
    { id: 'precheck', path: '/surveys/prescreen',     seconds: 0 },
    { id: 'bdli',     path: '/survey/bdli',           seconds: 0 },
    { id: 'techfam',  path: '/survey/techfam',        seconds: 0 },
  ];
}

// ────────────────────────────────────────────────────────────
export function buildPostFlow(assignment: InterfaceAssignment, cycles = 3): Section[] {
  const f: Section[] = [
    { id: 'fam',              path: `/familiarization/${assignment}`, seconds: 0 },
    { id: 'tlx_preview',      path: '/familiarization/tlx',           seconds: 0 },
    { id: 'cc_tlx_perf',      path: '/familiarization/imc/tlxperf',   seconds: 0 },
    { id: 'imc1',             path: '/familiarization/imc/Imc1',      seconds: 0 },
    { id: 'reliance_preview', path: '/familiarization/reliance',      seconds: 0 },
    { id: 'cc_rel',           path: '/familiarization/imc/reliancecc',seconds: 0 },
  ];

  for (let c = 1; c <= cycles; c++) {
    const td = getTaskDef(c);
    f.push(
      {
        id: 'task',
        cycle: c,
        path: `/${assignment}/${c}`,
        seconds: td.seconds,
        task_code: td.code,
        complexity: td.complexity,
      },
      { id: 'tlx',      cycle: c, path: `/survey/tlx/${c}`,      seconds: 0 },
      { id: 'reliance', cycle: c, path: `/survey/reliance/${c}`, seconds: 0 },
    );
    if (c === 1) f.push({ id: 'imc2', path: '/imc/Imc2', seconds: 0 });
  }
  f.push({ id: 'tools', path: '/imc/tools', seconds: 0 });
  f.push({ id: 'end', path: '/end', seconds: 0 });
  return f;
}

// Build the whole plan when/if assignment exists
export function buildFlow(assignment?: InterfaceAssignment, cycles = 3): Section[] {
  return assignment
    ? [...buildPreFlow(), ...buildPostFlow(assignment, cycles)]
    : buildPreFlow();
}
