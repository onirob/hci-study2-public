import { TASKS_BY_CYCLE } from '../data/tasks';
import type { Task } from '../components/TaskPanel';

export function getTaskForSection(section: any): {
  task: Task | null;
  code: string | null;
  cycle: number | null;
} {
  if (!section) return { task: null, code: null, cycle: null };

  // prefer explicit cycle in the flow section
  const cycleFromProp =
    Number.isFinite(section?.cycle) ? Number(section.cycle) : undefined;

  // fallback: parse /dashboard/:n or /chatbot/:n
  const path: string = section?.path ?? '';
  const m = path.match(/^\/(?:dashboard|chatbot)\/(\d+)/);
  const cycleFromPath = m ? Number(m[1]) : undefined;

  const cycle = cycleFromProp ?? cycleFromPath ?? null;

  // if the section embeds tasks, they win; else take catalog by cycle
  const embeddedTasks: Task[] =
    (Array.isArray(section?.tasks) ? section.tasks
      : section?.task ? [section.task]
      : section?.questions ? [{ code: section.code ?? 'q', title: section.title ?? 'Task', questions: section.questions }]
      : []);

  const idx = Number.isInteger(section?.taskIndex) ? section.taskIndex : 0;
  const embedded = embeddedTasks[idx];

  const catalog = cycle ? TASKS_BY_CYCLE[cycle] : undefined;
  const task = embedded ?? catalog ?? null;

  return { task, code: task?.code ?? null, cycle };
}
