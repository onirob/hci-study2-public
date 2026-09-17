import * as React from 'react';
import { Card, Box, Stack, Typography, useTheme } from '@mui/material';
import { alpha } from '@mui/material/styles';

type RingProps = {
  label: string;
  /** Value in percent after scaling. Can be >100 (label shows full value). */
  value: number | null | undefined;
  color: string;
  size?: number;        // px
  thickness?: number;   // ring thickness in px
};

function clamp100(v: number) {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, v));
}

function clamp01(v: number) {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function HorizontalGauge({
  value,                 // percent; can be >100 (we clamp for the knob only)
  height = 10,
  radius = 6,
}: {
  value: number | null | undefined;
  height?: number;
  radius?: number;
}) {
  const theme = useTheme();
  const pct = Number(value ?? 0);               // show raw number elsewhere
  const pos = clamp01(pct / 100);               // knob position (0..1)

  const cRed    = theme.palette.error.main;
  const cYellow = theme.palette.warning.main;
  const cGreen  = theme.palette.success.main;

  return (
    <Box sx={{ position: 'relative', width: '100%', height, borderRadius: radius,
               background: `linear-gradient(90deg, ${cRed}, ${cYellow}, ${cGreen})`,
               boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.08)' }}
         aria-label={`OEE gauge at ${Math.round(pct)} percent`}>
      {/* knob */}
      <Box sx={{
        position: 'absolute',
        left: `calc(${pos * 100}% - ${height * 0.65}px)`,
        top: '50%',
        transform: 'translateY(-50%)',
        width: height * 1.3,
        height: height * 1.3,
        borderRadius: '50%',
        backgroundColor: '#fff',
        boxShadow: '0 0 0 2px rgba(0,0,0,0.35)',
      }} />
    </Box>
  );
}

function Ring({ label, value, color, size = 88, thickness = 6 }: RingProps) {
  const theme = useTheme();

  // 1) Display value can exceed 100; arc is capped for visuals.
  const display = Number(value ?? 0);
  const arcPct = Math.max(0, Math.min(100, display));

  // 2) SVG geometry
  const r = (size - thickness) / 2;               // radius
  const cx = size / 2, cy = size / 2;
  const C = 2 * Math.PI * r;                       // circumference
  const dash = (arcPct / 100) * C;

  // 3) Colors
  const track = alpha('#FFFFFF', 0.12);

  // 4) Responsive label sizing (avoid overflow for 3–5+ chars)
  const labelText = `${Math.round(display)}%`;
  const len = labelText.length;
  const fontSize =
    len <= 3 ? 18 :
    len === 4 ? 16 :
    len === 5 ? 14 : 12;

  return (
    <Box
      sx={{
        width: size,
        height: size + 36,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
      }}
      role="group"
      aria-label={`${label}: ${labelText}`}
    >
      <Box sx={{ position: 'relative', width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
          {/* Track */}
          <circle
            cx={cx}
            cy={cy}
            r={r}
            stroke={track}
            strokeWidth={thickness}
            fill="none"
          />
          {/* Arc (start at 12 o’clock) */}
          <circle
            cx={cx}
            cy={cy}
            r={r}
            stroke={color}
            strokeWidth={thickness}
            fill="none"
            strokeDasharray={`${dash} ${C - dash}`}
            strokeLinecap="round"
            transform={`rotate(-90 ${cx} ${cy})`}
          />
        </svg>

        {/* Center value — always readable and centered */}
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            fontWeight: 700,
            color: theme.palette.text.primary,
            fontSize,
            lineHeight: 1,
            padding: 0.25, // tiny buffer for very long values
            textAlign: 'center',
            userSelect: 'none',
          }}
        >
          {labelText}
        </Box>
      </Box>

      <Typography variant="subtitle2" sx={{ mt: 1, fontWeight: 600 }}>
        {label}
      </Typography>
    </Box>
  );
}

export type OeeSummaryTileProps = {
  oee: number | null | undefined;          // 0..100 or 0..1 or >100
  availability: number | null | undefined; // 0..100 or 0..1 or >100
  performance: number | null | undefined;  // 0..100 or 0..1 or >100
  quality: number | null | undefined;      // 0..100 or 0..1 or >100
  title?: string;
};

export default function OeeSummaryTile({
  oee, availability, performance, quality, title = 'OEE',
}: OeeSummaryTileProps) {
  const theme = useTheme();

  // auto-detect scaling (values ≤ 1 treated as 0..1)
  const scale = (v: number | null | undefined) => {
    if (v == null) return 0;
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return n <= 1 ? n * 100 : n;  // keep >100 as-is
  };

  // Display values (can exceed 100)
  const oeeDisp  = scale(oee);
  const availDisp = scale(availability);
  const perfDisp  = scale(performance);
  const qualDisp  = scale(quality);

  // Colors
  const cAvail = theme.palette.warning.main;               // amber/orange
  const cPerf  = theme.palette.info.main || '#42a5f5';     // blue for Performance (NEW)
  const cQual  = theme.palette.success.main;               // green

  const big = { fontSize: 44, fontWeight: 800 };

  return (
    <Card sx={{ p: 2, height: '100%', borderRadius: 2 }}>
        {/* Title row (no Efficiency on the right) */}
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
            <Typography variant="subtitle2">OEE</Typography>
            {/* (empty on purpose) */}
        </Box>

        {/* Big number + % (never “No data”) */}
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.75, mb: 1 }}>
            <Typography sx={{ fontSize: 44, fontWeight: 800, lineHeight: 1 }}>
            {Number.isFinite(oeeDisp) ? Math.round(oeeDisp) : '—'}
            </Typography>
            <Typography sx={{ fontWeight: 700, opacity: 0.9, fontSize: 16 }}>%</Typography>
        </Box>

        {/* Gradient gauge (knob clamps to [0,100], text above shows real value) */}
        <Box sx={{ mb: 3 }}>
            <HorizontalGauge value={Number.isFinite(oeeDisp) ? oeeDisp : 0} />
        </Box>

        {/* Sub-metrics (your existing donuts/rings) */}
        <Stack direction="row" spacing={4} sx={{ justifyContent: 'space-between' }}>
            <Ring label="Availability" value={availDisp} color={theme.palette.warning.main} />
            <Ring label="Performance"  value={perfDisp}  color={theme.palette.info.main || '#42a5f5'} allowOverflow />
            <Ring label="Quality"      value={qualDisp}  color={theme.palette.success.main} />
        </Stack>
    </Card>
  );
}
