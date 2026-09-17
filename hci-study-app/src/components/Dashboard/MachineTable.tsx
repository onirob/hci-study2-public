import { Card, Stack, TextField, InputAdornment, Chip, Box, Tooltip, Link as MUILink } from '@mui/material';
import { DataGrid, GridLogicOperator } from '@mui/x-data-grid';
import type { GridColDef, GridFilterModel } from '@mui/x-data-grid';
import SearchRoundedIcon from '@mui/icons-material/SearchRounded';
import type { SxProps, Theme } from '@mui/material/styles';
import { alpha } from '@mui/material/styles';
import PauseIcon from '@mui/icons-material/Pause';
import PlayArrowRoundedIcon from '@mui/icons-material/PlayArrowRounded';
import PowerSettingsNewRoundedIcon from '@mui/icons-material/PowerSettingsNewRounded';
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded';

import { useMemo, useState } from 'react';

import { statusColor } from '../../utils/statusColor';
import type { AnyRow, StatusRow, ConsumptionRow, ProductivityRow } from '../../hooks/useDashboardData';

type Facet = 'status' | 'consumption' | 'productivity';

export type Props = {
  facet: Facet;
  /** Raw rows from /api/dashboard for the selected range & bucket */
  series: AnyRow[];
  /** Optional: kg CO₂ per kWh (if you want CO₂ column in consumption mode) */
  co2FactorKgPerKwh?: number;
  /** Called when the user clicks the machine name. You’ll pass this from Dashboard to open the overlay. */
  onNameClick?: (args: { id: string; name?: string; origin: Facet }) => void;
};

type StatusTableRow = {
  id: string;
  name: string;
  status: 'working' | 'idle' | 'offline' | 'alarm';
  utilization: number | null;
  working_sec: number;
  idle_sec: number;
  alarm_sec: number;
  offline_sec: number;
  alarm_starts: number;
};

type ConsumptionTableRow = {
  id: string;
  name: string;
  kwh: number;           // total (delta)
  kwh_working: number;   // sum of consumption_working
  kwh_idle: number;      // sum of consumption_idle
  cost: number;
  co2kg?: number;
};
type ProductivityTableRow = {
  id: string;
  name: string;
  cycles: number;
  good: number;
  avg_cycle_time: number;
  availability: number | null; 
  performance: number | null;
  quality: number | null;
  oee: number | null;
  cost: number;
};

function fmtHMS(totalSec: number | null | undefined) {
  if (totalSec == null || Number.isNaN(totalSec)) return '—';
  const s = Math.max(0, Math.floor(Number(totalSec)));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(ss)}`;
}

const gridSx: SxProps<Theme> = {
  '& .MuiDataGrid-virtualScrollerRenderZone': { marginTop: 0 },
  '& .MuiDataGrid-columnHeaders': (t) => ({
    backgroundColor: alpha(t.palette.text.primary, 0.04),
    borderBottom: `1px solid ${t.palette.divider}`,
  }),
  '& .MuiDataGrid-columnHeaderTitle': (t) => ({
    fontWeight: 700,
    fontSize: '0.75rem',
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: t.palette.text.secondary,
    lineHeight: 1.2,
  }),
  '& .MuiDataGrid-iconSeparator': { display: 'none' },
  '& .MuiDataGrid-cell': (t) => ({
    fontSize: '0.92rem',
    color: t.palette.text.primary,
    borderBottom: `1px solid ${t.palette.divider}`,
    fontVariantNumeric: 'tabular-nums',
  }),
  '& .MuiDataGrid-row:nth-of-type(odd) .MuiDataGrid-cell': (t) => ({
    backgroundColor: alpha(t.palette.primary.main, 0.03),
  }),
  '& .MuiDataGrid-row:hover .MuiDataGrid-cell': (t) => ({
    backgroundColor: alpha(t.palette.primary.main, 0.06),
  }),
  '& .MuiDataGrid-cell:focus, & .MuiDataGrid-columnHeader:focus': { outline: 'none' },
};

export default function MachineTable({ facet, series, co2FactorKgPerKwh, onNameClick }: Props) {
  const thinNbsp = '\u202F';
  const nf0 = new Intl.NumberFormat('en-EN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const nf1 = new Intl.NumberFormat('en-EN', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const eur = new Intl.NumberFormat('en-EN', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2, currencyDisplay: 'narrowSymbol' });

  // ---------- Aggregations per facet (typed) ----------
  const statusRows = useMemo<StatusTableRow[]>(() => {
    if (facet !== 'status') return [];
    const byId = new Map<string, StatusTableRow>();
    for (const r0 of series as StatusRow[]) {
      const r = r0 as any;
      const id = r.machine_id; if (!id) continue;
      const name = r.machine_name ?? id;

      const acc = byId.get(id) ?? {
        id, name,
        status: 'offline',
        utilization: null,
        working_sec: 0, idle_sec: 0, offline_sec: 0, alarm_sec: 0,
        alarm_starts: 0,
      };
      acc.working_sec += Number(r.working_time ?? 0);
      acc.idle_sec    += Number(r.idle_time ?? 0);
      acc.offline_sec += Number(r.offline_time ?? 0);
      acc.alarm_sec   += Number(r.alarm_time ?? 0);
      acc.alarm_starts += Number(r.alarm_start_count ?? 0);
      byId.set(id, acc);
    }
    for (const acc of byId.values()) {
      const denom = acc.working_sec + acc.idle_sec + acc.alarm_sec;
      acc.utilization = denom > 0 ? (acc.working_sec / denom) * 100 : null;
      const buckets = [
        ['working', acc.working_sec],
        ['idle', acc.idle_sec],
        ['alarm', acc.alarm_sec],
        ['offline', acc.offline_sec],
      ] as const;
      buckets.sort((a, b) => b[1] - a[1]);
      acc.status = buckets[0][0] as StatusTableRow['status'];
    }
    return Array.from(byId.values());
  }, [series, facet]);

  const consumptionRows = useMemo<ConsumptionTableRow[]>(() => {
    if (facet !== 'consumption') return [];
    const byId = new Map<string, ConsumptionTableRow>();

    for (const r0 of series as ConsumptionRow[]) {
      const r = r0 as any;
      const id = r.machine_id; if (!id) continue;
      const name = r.machine_name ?? id;

      const acc = byId.get(id) ?? { id, name, kwh: 0, kwh_working: 0, kwh_idle: 0, cost: 0 };
      acc.kwh          += Number(r.consumption_total   ?? 0);
      acc.kwh_working  += Number(r.consumption_working ?? 0);
      acc.kwh_idle     += Number(r.consumption_idle    ?? 0);
      acc.cost         += Number(r.cost                ?? 0);
      byId.set(id, acc);
    }

    if (co2FactorKgPerKwh && Number.isFinite(co2FactorKgPerKwh)) {
      for (const acc of byId.values()) acc.co2kg = acc.kwh * Number(co2FactorKgPerKwh);
    }
    return Array.from(byId.values());
  }, [series, facet, co2FactorKgPerKwh]);

  const productivityRows = useMemo<ProductivityTableRow[]>(() => {
    if (facet !== 'productivity') return [];
    const byId = new Map<string, (ProductivityTableRow & {
      oee_sum?: number; oee_n?: number;
      av_sum?: number;  av_n?: number;
      pf_sum?: number;  pf_n?: number;
      qu_sum?: number;  qu_n?: number;
      act_sum?: number; act_n?: number;   // avg cycle time accumulators
    })>();

    for (const r0 of series as ProductivityRow[]) {
      const r = r0 as any;
      const id = r.machine_id; if (!id) continue;
      const name = r.machine_name ?? id;

      const acc = byId.get(id) ?? {
        id, name,
        cycles: 0, good: 0, cost: 0,
        avg_cycle_time: null,
        availability: null, performance: null, quality: null, oee: null,
        oee_sum: 0, oee_n: 0, av_sum: 0, av_n: 0, pf_sum: 0, pf_n: 0, qu_sum: 0, qu_n: 0,
        act_sum: 0, act_n: 0,
      };

      acc.cycles += Number(r.cycles ?? 0);
      acc.good   += Number(r.good_cycles ?? 0);
      acc.cost   += Number(r.cost ?? 0);

      if (r.oee != null)                 { acc.oee_sum! += Number(r.oee);                 acc.oee_n! += 1; }
      if (r.availability != null)        { acc.av_sum!  += Number(r.availability);        acc.av_n!  += 1; }
      if (r.performance != null)         { acc.pf_sum!  += Number(r.performance);         acc.pf_n!  += 1; }
      if (r.quality != null)             { acc.qu_sum!  += Number(r.quality);             acc.qu_n!  += 1; }
      const avgCT = (r.avg_cycle_time ?? r.average_cycle_time);
      if (avgCT != null)                 { acc.act_sum! += Number(avgCT);                 acc.act_n! += 1; }

      byId.set(id, acc);
    }

    const out: ProductivityTableRow[] = [];
    for (const acc of byId.values()) {
      out.push({
        id: acc.id, name: acc.name,
        cycles: acc.cycles, good: acc.good,
        avg_cycle_time: acc.act_n! ? acc.act_sum! / acc.act_n! : null,
        availability: acc.av_n! ? acc.av_sum! / acc.av_n! : null,
        performance:  acc.pf_n! ? acc.pf_sum! / acc.pf_n! : null,
        quality:      acc.qu_n! ? acc.qu_sum! / acc.qu_n! : null,
        oee:          acc.oee_n! ? acc.oee_sum! / acc.oee_n! : null,
        cost: acc.cost,
      });
    }
    return out;
  }, [series, facet]);

  // ----- Name cell (clickable for status + consumption) -----
  const renderNameCell = (origin: Facet) =>
    (params: any) => {
      const { id, name } = params.row as { id: string; name: string };
      const clickable = !!onNameClick;
      if (!clickable) return name;

      const handle = () => onNameClick?.({ id, name, origin });
      const onKey = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handle(); }
      };

      return (
        <Tooltip title="Open machine details">
          <MUILink
            component="button"
            onClick={handle}
            onKeyDown={onKey}
            underline="hover"
            color="info.main"
            sx={{ fontWeight: 700, cursor: 'pointer' }}
            data-eid="machine.name.click"
          >
            {name}
          </MUILink>
        </Tooltip>
      );
    };

  // ---------- Columns per facet (typed) ----------
  const statusCols = useMemo<GridColDef<StatusTableRow>[]>(() => [
    { field: 'name', headerName: 'Machine name', flex: 1.3, minWidth: 160, renderCell: renderNameCell('status') },
    {
      field: 'status',
      headerName: 'Status (dominant)',
      flex: 0.9,
      minWidth: 150,
      sortable: false,
      renderCell: (params) => {
        const s = String(params.value ?? 'offline') as 'working' | 'idle' | 'offline' | 'alarm';
        const icon =
          s === 'working' ? <PlayArrowRoundedIcon /> :
          s === 'idle'    ? <PauseIcon /> :
          s === 'alarm'   ? <WarningAmberRoundedIcon /> :
                            <PowerSettingsNewRoundedIcon />;
        return (
          <Chip
            size="small"
            icon={icon}
            label={s.charAt(0).toUpperCase() + s.slice(1)}
            sx={(t) => {
              const col = {
                working: t.palette.success.main,
                idle:    t.palette.info.main,
                alarm:   t.palette.error.main,
                offline: t.palette.grey[500],
              }[s];
              return {
                color: '#cfe8ff',
                bgcolor: alpha(col, 0.18),
                borderColor: alpha(col, 0.5),
                borderWidth: 1,
                borderStyle: 'solid',
                height: 28,
                fontWeight: 600,
                fontSize: '0.8rem',
                '& .MuiChip-icon': { color: col },
              };
            }}
          />
        );
      },
    },
    {
      field: 'working_sec', headerName: 'Working Time', flex: 0.9, minWidth: 120, align: 'right', headerAlign: 'right',
      renderCell: (p) => fmtHMS((p.row as StatusTableRow)?.working_sec ?? 0),
    },
    {
      field: 'idle_sec', headerName: 'Idle Time', flex: 0.8, minWidth: 110, align: 'right', headerAlign: 'right',
      renderCell: (p) => fmtHMS((p.row as StatusTableRow)?.idle_sec ?? 0),
    },
    {
      field: 'alarm_sec', headerName: 'Alarm Time', flex: 0.8, minWidth: 110, align: 'right', headerAlign: 'right',
      renderCell: (p) => fmtHMS((p.row as StatusTableRow)?.alarm_sec ?? 0),
    },
    {
      field: 'offline_sec', headerName: 'Offline Time', flex: 0.9, minWidth: 120, align: 'right', headerAlign: 'right',
      renderCell: (p) => fmtHMS((p.row as StatusTableRow)?.offline_sec ?? 0),
    },
    {
      field: 'alarm_starts', headerName: '# Alarms', type: 'number',
      align: 'right', headerAlign: 'right', flex: 0.7, minWidth: 110,
    },
  ], [renderNameCell]);

  const consumptionCols = useMemo<GridColDef<ConsumptionTableRow>[]>(() => [
    { field: 'name', headerName: 'Machine name', flex: 1.3, minWidth: 180, renderCell: renderNameCell('consumption') },
    {
      field: 'kwh', headerName: 'Consumption (total)', align: 'right', headerAlign: 'right',
      flex: 0.9, minWidth: 160,
      renderCell: (p) => {
        const n = Number((p.row as ConsumptionTableRow)?.kwh ?? 0);
        return Number.isFinite(n) ? `${nf0.format(n)}${thinNbsp}kWh` : '—';
      },
    },
    {
      field: 'kwh_working', headerName: 'Working', align: 'right', headerAlign: 'right',
      flex: 0.8, minWidth: 130,
      renderCell: (p) => {
        const n = Number((p.row as ConsumptionTableRow)?.kwh_working ?? 0);
        return Number.isFinite(n) ? `${nf0.format(n)}${thinNbsp}kWh` : '—';
      },
    },
    {
      field: 'kwh_idle', headerName: 'Idle', align: 'right', headerAlign: 'right',
      flex: 0.8, minWidth: 130,
      renderCell: (p) => {
        const n = Number((p.row as ConsumptionTableRow)?.kwh_idle ?? 0);
        return Number.isFinite(n) ? `${nf0.format(n)}${thinNbsp}kWh` : '—';
      },
    },
    {
      field: 'cost', headerName: 'Cost', align: 'right', headerAlign: 'right',
      flex: 0.8, minWidth: 120,
      renderCell: (p) => {
        const n = Number((p.row as ConsumptionTableRow)?.cost ?? 0);
        return Number.isFinite(n) ? eur.format(n) : '—';
      },
    },
  ], [eur, nf0, renderNameCell, thinNbsp]);

  const productivityCols = useMemo<GridColDef<ProductivityTableRow>[]>(() => {
    const fmtPct = (v: number | null | undefined) => {
      if (v == null || Number.isNaN(Number(v))) return '—';
      const val = Number(v) <= 1.000001 ? Number(v) * 100 : Number(v);
      return `${nf1.format(val)}%`;
    };

    return [
      { field: 'name', headerName: 'Machine name', flex: 1.3, minWidth: 160,
        renderCell: renderNameCell('productivity') },

      { field: 'avg_cycle_time', headerName: 'Avg cycle time', align: 'right', headerAlign: 'right',
        flex: 0.9, minWidth: 140,
        renderCell: (p) => {
          const v = (p.row as ProductivityTableRow)?.avg_cycle_time;
          return v == null ? '—' : `${nf1.format(Number(v))}s`;
      }},

      { field: 'cycles', headerName: 'Cycles', align: 'right', headerAlign: 'right',
        flex: 0.7, minWidth: 100,
        renderCell: (p) => String((p.row as ProductivityTableRow)?.cycles ?? 0) },

      { field: 'good', headerName: 'Good', align: 'right', headerAlign: 'right',
        flex: 0.6, minWidth: 90,
        renderCell: (p) => String((p.row as ProductivityTableRow)?.good ?? 0) }, 

      { field: 'availability', headerName: 'Availability', align: 'right', headerAlign: 'right',
        flex: 0.8, minWidth: 110,
        renderCell: (p) => fmtPct((p.row as ProductivityTableRow)?.availability) },

      { field: 'performance', headerName: 'Performance', align: 'right', headerAlign: 'right',
        flex: 0.8, minWidth: 110,
        renderCell: (p) => fmtPct((p.row as ProductivityTableRow)?.performance) },

      { field: 'quality', headerName: 'Quality', align: 'right', headerAlign: 'right',
        flex: 0.8, minWidth: 110,
        renderCell: (p) => fmtPct((p.row as ProductivityTableRow)?.quality) },

      { field: 'oee', headerName: 'OEE', align: 'right', headerAlign: 'right',
        flex: 0.8, minWidth: 110,
        renderCell: (p) => fmtPct((p.row as ProductivityTableRow)?.oee) },

      { field: 'cost', headerName: 'Cost', align: 'right', headerAlign: 'right',
        flex: 0.8, minWidth: 120,
        renderCell: (p) => {
          const n = Number((p.row as ProductivityTableRow)?.cost ?? 0);
          return Number.isFinite(n) ? eur.format(n) : '—';
        }},
    ];
  }, [eur, nf1, renderNameCell]);



  // ---------- Search (quick filter) ----------
  const [filterModel, setFilterModel] = useState<GridFilterModel>({
    items: [],
    quickFilterValues: [],
    quickFilterLogicOperator: GridLogicOperator.And,
  });
  const handleSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value.trim();
    setFilterModel((prev) => ({ ...prev, quickFilterValues: v ? [v] : [] }));
  };

  return (
    <Card sx={{ p: 2, width: '100%' }}>
      <Stack direction="row" spacing={1.5} alignItems="center" sx={{ px: 0, pt: 0, pb: 1.5 }}>
        <TextField
          value={filterModel.quickFilterValues?.[0] ?? ''}
          onChange={handleSearch}
          placeholder="Filter by machine name…"
          size="small"
          fullWidth={false}
          variant="outlined"
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchRoundedIcon fontSize="small" />
              </InputAdornment>
            ),
          }}
          sx={{
            width: { xs: '100%', sm: 340 },
            '& .MuiInputBase-root': { borderRadius: 999, bgcolor: 'background.paper' },
          }}
        />
      </Stack>

      <Box>
        {facet === 'status' && (
          <DataGrid<StatusTableRow>
            autoHeight
            density="compact"
            rows={statusRows}
            columns={statusCols}
            getRowId={(r) => r.id}
            pageSizeOptions={[5, 10, 25]}
            initialState={{ pagination: { paginationModel: { pageSize: 10, page: 0 } } }}
            disableRowSelectionOnClick
            filterModel={filterModel}
            onFilterModelChange={setFilterModel}
            disableColumnFilter
            checkboxSelection={false}
            sx={{ width: '100%', ...gridSx }}
          />
        )}

        {facet === 'consumption' && (
          <DataGrid<ConsumptionTableRow>
            autoHeight
            density="compact"
            rows={consumptionRows}
            columns={consumptionCols}
            getRowId={(r) => r.id}
            pageSizeOptions={[5, 10, 25]}
            initialState={{ pagination: { paginationModel: { pageSize: 10, page: 0 } } }}
            disableRowSelectionOnClick
            filterModel={filterModel}
            onFilterModelChange={setFilterModel}
            disableColumnFilter
            checkboxSelection={false}
            sx={{ width: '100%', ...gridSx }}
          />
        )}

        {facet === 'productivity' && (
          <DataGrid<ProductivityTableRow>
            autoHeight
            density="compact"
            rows={productivityRows}
            columns={productivityCols}
            getRowId={(r) => r.id}
            pageSizeOptions={[5, 10, 25]}
            initialState={{ pagination: { paginationModel: { pageSize: 10, page: 0 } } }}
            disableRowSelectionOnClick
            filterModel={filterModel}
            onFilterModelChange={setFilterModel}
            disableColumnFilter
            checkboxSelection={false}
            sx={{ width: '100%', ...gridSx }}
          />
        )}
      </Box>
    </Card>
  );
}
