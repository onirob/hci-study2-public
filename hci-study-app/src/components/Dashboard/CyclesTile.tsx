// src/components/Dashboard/CyclesTile.tsx
import * as React from "react";
import { Card, Box, Stack, Typography } from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";

type Props = {
  /** total cycles (optional; if omitted we use good+bad) */
  cycles?: number | null;
  /** good cycles */
  goodCycles?: number | null;
  /** bad cycles */
  badCycles?: number | null;
  title?: string;
  /** outer size of the donut (px) — slightly smaller ring by default */
  size?: number;
  /** ring thickness (px) */
  thickness?: number;
};

export default function CyclesTile({
  cycles,
  goodCycles = 0,
  badCycles = 0,
  title = "Cycles",
  size = 220,
  thickness = 22,
}: Props) {
  const theme = useTheme();

  // Colors (rail + legend-matched arcs)
  const colGood = theme.palette.success.main ?? "#4caf50";
  const colBad = theme.palette.error.main ?? "#ef5350";
  const rail = alpha("#FFFFFF", 0.18);
  const textDim = alpha("#FFFFFF", 0.7);

  // Numbers
  const nf0 = React.useMemo(
    () => new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 }),
    []
  );
  const pf2 = React.useMemo(
    () =>
      new Intl.NumberFormat("en-GB", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }),
    []
  );

  const total =
    (typeof cycles === "number" && !Number.isNaN(cycles)
      ? Math.max(0, cycles)
      : Math.max(0, (goodCycles ?? 0) + (badCycles ?? 0))) || 0;

  const good = Math.max(0, Number(goodCycles ?? 0));
  const bad =
    typeof cycles === "number" && !Number.isNaN(cycles)
      ? Math.max(0, total - good)
      : Math.max(0, Number(badCycles ?? 0));

  const pGood = total > 0 ? good / total : 0;
  const pBad = total > 0 ? bad / total : 0;

  // Donut geometry
  const cx = size / 2;
  const cy = size / 2;
  const radius = size / 2 - thickness / 2;
  const TAU = Math.PI * 2;
  const START = -Math.PI / 2; // 12 o'clock
  const EPS = 1e-6;

  function polar(cx: number, cy: number, r: number, a: number) {
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  }

  // Safe arc: clamps delta to < 2π to avoid zero-length paths.
  function arcPath(cx: number, cy: number, r: number, a0: number, a1: number) {
    // Normalize and clamp to avoid exactly 2π
    let delta = a1 - a0;
    if (delta >= TAU) delta = TAU - 1e-4; // tiny clamp
    if (delta <= 0) delta = 0;

    const largeArc = delta > Math.PI ? 1 : 0;
    const p0 = polar(cx, cy, r, a0);
    const p1 = polar(cx, cy, r, a0 + delta);
    return `M ${p0.x} ${p0.y} A ${r} ${r} 0 ${largeArc} 1 ${p1.x} ${p1.y}`;
  }

  // Helpers to detect (near-)full rings
  const isFullGood = pGood >= 1 - EPS && total > 0;
  const isFullBad = !isFullGood && pBad >= 1 - EPS && total > 0;

  return (
    <Card sx={{ p: 2 }}>
      <Typography variant="subtitle1" sx={{ mb: 1, color: textDim }}>
        {title}
      </Typography>

      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: `${size}px 1fr`,
          alignItems: "center",
          gap: 2,
        }}
      >
        {/* Donut */}
        <Box sx={{ position: "relative", width: size, height: size }}>
          <svg
            width={size}
            height={size}
            role="img"
            aria-label={`Cycles: total ${nf0.format(
              total
            )}. Good ${pf2.format(pGood * 100)}%, Bad ${pf2.format(
              pBad * 100
            )}%`}
          >
            {/* Rail */}
            <circle
              cx={cx}
              cy={cy}
              r={radius}
              fill="none"
              stroke={rail}
              strokeWidth={thickness}
            />

            {/* Segments */}
            <g transform={`rotate(0 ${cx} ${cy})`}>
              {isFullBad ? (
                // Full red ring
                <circle
                  cx={cx}
                  cy={cy}
                  r={radius}
                  fill="none"
                  stroke={colBad}
                  strokeWidth={thickness}
                  pointerEvents="stroke"
                >
                  <title>{`Bad: ${nf0.format(bad)} (100.00%)`}</title>
                </circle>
              ) : pBad > EPS ? (
                <path
                  d={arcPath(cx, cy, radius, START, START + TAU * pBad)}
                  fill="none"
                  stroke={colBad}
                  strokeWidth={thickness}
                  strokeLinecap="butt"
                  pointerEvents="stroke"
                >
                  <title>{`Bad: ${nf0.format(
                    Math.round(pBad * total)
                  )} (${pf2.format(pBad * 100)}%)`}</title>
                </path>
              ) : null}

              {isFullGood ? (
                // Full green ring
                <circle
                  cx={cx}
                  cy={cy}
                  r={radius}
                  fill="none"
                  stroke={colGood}
                  strokeWidth={thickness}
                  pointerEvents="stroke"
                >
                  <title>{`Good: ${nf0.format(good)} (100.00%)`}</title>
                </circle>
              ) : pGood > EPS ? (
                <path
                  d={arcPath(
                    cx,
                    cy,
                    radius,
                    START + TAU * pBad,
                    START + TAU * (pBad + pGood)
                  )}
                  fill="none"
                  stroke={colGood}
                  strokeWidth={thickness}
                  strokeLinecap="butt"
                  pointerEvents="stroke"
                >
                  <title>{`Good: ${nf0.format(
                    Math.round(pGood * total)
                  )} (${pf2.format(pGood * 100)}%)`}</title>
                </path>
              ) : null}
            </g>
          </svg>

          {/* Center total */}
          <Box
            sx={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              pointerEvents: "none",
              textAlign: "center",
            }}
          >
            <Stack spacing={0.25} sx={{ alignItems: "center" }}>
              <Typography
                variant="h4"
                sx={{ fontWeight: 800, lineHeight: 1, letterSpacing: 0.5 }}
              >
                {nf0.format(total)}
              </Typography>
              <Typography variant="caption" sx={{ color: textDim }}>
                total
              </Typography>
            </Stack>
          </Box>
        </Box>

        {/* Legend */}
        <Stack spacing={1} sx={{ alignSelf: "center" }}>
          <LegendRow
            color={colGood}
            label="Good"
            value={`${pf2.format(pGood * 100)}%`}
          />
          <LegendRow
            color={colBad}
            label="Bad"
            value={`${pf2.format(pBad * 100)}%`}
          />
        </Stack>
      </Box>
    </Card>
  );
}

function LegendRow({
  color,
  label,
  value,
}: {
  color: string;
  label: string;
  value: string;
}) {
  return (
    <Stack direction="row" spacing={1.25} alignItems="center">
      <Box sx={{ width: 10, height: 10, borderRadius: 1, bgcolor: color }} />
      <Typography variant="body1" sx={{ fontWeight: 600 }}>
        {label}
      </Typography>
      <Typography variant="body2" sx={{ opacity: 0.8 }}>
        {value}
      </Typography>
    </Stack>
  );
}
