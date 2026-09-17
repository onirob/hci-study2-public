import * as React from 'react';
import {
  Box, Stack, Typography, RadioGroup, FormControlLabel, Radio, TextField, MenuItem
} from '@mui/material';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterDateFns } from '@mui/x-date-pickers/AdapterDateFns';

export type QuestionType = 'single' | 'number' | 'text' | 'date';

export type Question = {
  id: string;
  prompt: string;
  type: QuestionType;
  options?: { value: string; label: string }[];
  required?: boolean;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  helperText?: string;
  minDate?: Date;
  maxDate?: Date;
  widget?: 'radio' | 'select';
  shuffleOptions?: boolean;

  /** Questions sharing this cannot reuse each other's selected value */
  exclusiveGroup?: string;

  /** For this group: once a family is used in another question,
   *  this question must hide all options from that family. */
  disallowFamilyRepeat?: boolean;
};

export type Task = {
  code: string;
  title: string;
  description?: string;
  complexity?: number;
  questions: Question[];
};

type Props = {
  task: Task;
  answers: Record<string, string>;
  onChange: (qid: string, value: string) => void;
};

const isValidNumberInput = (s: string) => /^-?\d*([.,]\d*)?$/.test(s || '');

export function validateTask(task: Task, answers: Record<string, string>) {
  const missing: string[] = [];

  for (const q of task.questions) {
    if (!q.required) continue;

    const v = answers[q.id];

    if (q.type === 'single') {
      if (!v) missing.push(q.prompt);
    } else if (q.type === 'number') {
      if (v == null || v === '' || !isValidNumberInput(v)) {
        missing.push(q.prompt);
        continue;
      }

      const num = Number(v);

      if (Number.isNaN(num)) {
        missing.push(q.prompt);
        continue;
      }

      if (q.min != null && num < q.min) {
        missing.push(`${q.prompt} (must be ≥ ${q.min})`);
        continue;
      }
      if (q.max != null && num > q.max) {
        missing.push(`${q.prompt} (must be ≤ ${q.max})`);
        continue;
      }
    } else if (q.type === 'text') {
      if ((v ?? '').trim() === '') missing.push(q.prompt);
    } else if (q.type === 'date') {
      if (!v) missing.push(q.prompt);
    }
  }

  return { ok: missing.length === 0, missing };
}

// --- helpers for families ---

function familyOfLabel(name: string): string | null {
  const n = (name || '').toLowerCase();
  if (n.includes('assembly')) return 'Assembly';
  if (n.includes('riveting')) return 'Riveting';
  if (n.includes('large')) return 'Cutting — Large';
  if (n.includes('medium')) return 'Cutting — Medium';
  if (n.includes('low')) return 'Cutting — Low';
  // Important: check "cutter" before generic "laser"
  if (n.includes('cutter')) return 'Laser Cutter';
  if (n.includes('laser')) return 'Laser Welding';
  if (n.includes('testing')) return 'Testing';
  return null;
}

type SingleChoiceProps = {
  question: Question;
  value: string;
  onChange: (value: string) => void;
  disabledValues?: string[];
  /** Families that are already used in other questions of the same group */
  disallowedFamilies?: string[];
};

function shuffleArray<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function SingleChoiceQuestion({
  question: q,
  value,
  onChange,
  disabledValues = [],
  disallowedFamilies = [],
}: SingleChoiceProps) {
  // Shuffle once on mount if requested
  const [baseOptions] = React.useState(() => {
    const base = q.options ?? [];
    if (!q.shuffleOptions) return base;
    return shuffleArray(base);
  });

  // If the current value becomes illegal (duplicate or family already used), clear it
  React.useEffect(() => {
    if (!value) return;

    const isDisabled = disabledValues.includes(value);

    let isDisallowedFamily = false;
    if (disallowedFamilies.length > 0) {
      const opt = baseOptions.find((o) => o.value === value);
      if (opt) {
        const fam = familyOfLabel(opt.label);
        if (fam && disallowedFamilies.includes(fam)) {
          isDisallowedFamily = true;
        }
      }
    }

    if (isDisabled || isDisallowedFamily) {
      onChange('');
    }
  }, [value, disabledValues, disallowedFamilies, baseOptions, onChange]);

  // Visible options: remove taken values and options from already-used families
  const options = React.useMemo(
    () =>
      baseOptions.map((opt) => {
        const fam = familyOfLabel(opt.label);
        const isDisabled =
          disabledValues.includes(opt.value) ||
          (disallowedFamilies.length > 0 &&
            fam != null &&
            disallowedFamilies.includes(fam));

        return { ...opt, disabled: isDisabled };
      }),
    [baseOptions, disabledValues, disallowedFamilies]
  );


  const label = `${q.prompt}${q.required ? ' *' : ''}`;

  // Dropdown / select variant
  if (q.widget === 'select') {
    return (
      <Box>
        <TextField
          select
          fullWidth
          label={label}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          
        >
          <MenuItem value="">
            <em>{q.placeholder || 'Select an option'}</em>
          </MenuItem>
            {options.map((opt) => (
              <MenuItem
                key={opt.value}
                value={opt.value}
                disabled={opt.disabled}
                data-eid={`answer.${q.id}.option.${opt.value}`}
              >
                {opt.label}
              </MenuItem>
            ))}
        </TextField>
      </Box>
    );
  }

  // Default: radio group
  return (
    <Box>
      <Typography variant="subtitle2" gutterBottom>
        {label}
      </Typography>
      <RadioGroup
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
      {options.map((opt) => (
        <FormControlLabel
          key={opt.value}
          value={opt.value}
          control={<Radio />}
          label={opt.label}
          disabled={opt.disabled}
          data-eid={`answer.${q.id}.option.${opt.value}`}
        />
      ))}
      </RadioGroup>
    </Box>
  );
}

export default function TaskPanel({ task, answers, onChange }: Props) {
  // Map option value → label (for family detection from answers)
  const valueToLabel = React.useMemo(() => {
    const map: Record<string, string> = {};
    for (const q of task.questions) {
      if (!q.options) continue;
      for (const opt of q.options) {
        if (map[opt.value] == null) {
          map[opt.value] = opt.label;
        }
      }
    }
    return map;
  }, [task.questions]);

  // For each exclusiveGroup, collect current selections
  const groupSelections: Record<string, Record<string, string>> = {};
  for (const q of task.questions) {
    if (!q.exclusiveGroup) continue;
    const v = answers[q.id];
    if (!v) continue;
    if (!groupSelections[q.exclusiveGroup]) {
      groupSelections[q.exclusiveGroup] = {};
    }
    groupSelections[q.exclusiveGroup][q.id] = v;
  }

  return (
    <LocalizationProvider dateAdapter={AdapterDateFns}>
      <Box>
        <Typography variant="h6" gutterBottom>{task.title}</Typography>
        {task.description && (
          <Typography
            variant="body1"
            sx={{
              color: 'text.secondary',
              mb: 2,
              whiteSpace: 'pre-line',
            }}
          >
            {task.description}
          </Typography>
        )}
        <Stack spacing={2}>
          {task.questions.map((q) => {
            if (q.type === 'single') {
              let disabledValues: string[] = [];
              let disallowedFamilies: string[] = [];

              if (q.exclusiveGroup) {
                const group = groupSelections[q.exclusiveGroup] ?? {};

                // no duplicate machines inside this group
                disabledValues = Object.entries(group)
                  .filter(([qid]) => qid !== q.id)
                  .map(([, v]) => v);

                // optional "no same family" rule:
                if (q.disallowFamilyRepeat) {
                  const famSet = new Set<string>();
                  for (const [qid, v] of Object.entries(group)) {
                    if (qid === q.id) continue;
                    const label = valueToLabel[v] ?? '';
                    const fam = familyOfLabel(label);
                    if (fam) famSet.add(fam);
                  }
                  disallowedFamilies = Array.from(famSet);
                }
              }

              return (
                <SingleChoiceQuestion
                  key={q.id}
                  question={q}
                  value={answers[q.id] ?? ''}
                  onChange={(val) => onChange(q.id, val)}
                  disabledValues={disabledValues}
                  disallowedFamilies={disallowedFamilies}
                />
              );
            }

            if (q.type === 'number') {
              const val = answers[q.id] ?? '';
              const num = val === '' ? null : Number(val);
              const outOfRange =
                num != null &&
                !Number.isNaN(num) &&
                ((q.min != null && num < q.min) || (q.max != null && num > q.max));

              return (
                <TextField
                  key={q.id}
                  fullWidth
                  type="number"
                  label={`${q.prompt}${q.required ? ' *' : ''}`}
                  value={val}
                  onChange={(e) => onChange(q.id, e.target.value)}
                  inputProps={{
                    inputMode: 'decimal',
                    step: q.step ?? 'any',
                    min: q.min ?? undefined,
                    max: q.max ?? undefined,
                  }}
                  error={outOfRange}
                  helperText={
                    outOfRange
                      ? `Value must be between ${q.min ?? '−∞'} and ${q.max ?? '+∞'}`
                      : q.helperText ??
                        (q.min != null || q.max != null
                          ? `Allowed range ${q.min ?? '−∞'} to ${q.max ?? '+∞'}`
                          : '')
                  }
                />
              );
            }

            if (q.type === 'date') {
              const raw = answers[q.id];
              const value = raw ? new Date(raw) : null;

              const minDate = q.minDate ?? new Date(2025, 1, 1);  // Feb 1
              const maxDate = q.maxDate ?? new Date(2025, 1, 28); // Feb 28

              return (
                <DatePicker
                  key={q.id}
                  label={`${q.prompt}${q.required ? ' *' : ''}`}
                  value={value}
                  minDate={minDate}
                  maxDate={maxDate}
                  views={['day']}
                  onChange={(date) => {
                    if (!date) {
                      onChange(q.id, '');
                      return;
                    }

                    let d = date;
                    if (d < minDate) d = minDate;
                    if (d > maxDate) d = maxDate;

                    onChange(
                      q.id,
                      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
                    );
                  }}
                  slotProps={{
                    textField: {
                      inputProps: { 'data-eid': `answer.${task.code}.${q.id}.date.input` },
                    },
                    openPickerButton: {
                      sx: { '&': { 'data-eid': `answer.${task.code}.${q.id}.date.open` } },
                    },
                    desktopPaper: {
                      sx: { '&': { 'data-eid': `answer.${task.code}.${q.id}.date.paper` } },
                    },
                    popper: {
                      sx: { '&': { 'data-eid': `answer.${task.code}.${q.id}.date.popper` } },
                    },
                  }}
                />
              );
            }

            // text
            return (
              <TextField
                key={q.id}
                fullWidth
                multiline
                minRows={2}
                label={`${q.prompt}${q.required ? ' *' : ''}`}
                value={answers[q.id] ?? ''}
                onChange={(e) => onChange(q.id, e.target.value)}
                placeholder={q.placeholder}
                helperText={q.helperText}
              />
            );
          })}
        </Stack>
      </Box>
    </LocalizationProvider>
  );
}
