import { useEffect, useMemo, useState } from 'react';
import {
  Alert, Button, Card, Col, DatePicker, Empty, Radio, Row, Select, Space, Spin,
  Statistic, Table, Tabs, Tag, Typography, message,
} from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { Dayjs } from 'dayjs';
import {
  CartesianGrid, Legend, Line, LineChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import api from '../services/api';
import { useIrDevices, irDisplayLabel, type IrDevice } from '../hooks/useIrDevices';
import {
  useActiveAlerts,
  useAlertHistory,
  computeDeviceHealth,
  findEdgeDownAlerts,
  type AlertActive,
  type AlertHistoryEvent,
} from '../hooks/useAlerts';
import AlertsHistory from './AlertsHistory';
import { FF_REPORTS_LINECHART_ENABLED } from '../lib/featureFlags';
import HistoryTable, {
  type Granularity,
  type HistoryColumnSpec,
  type HistoryRow,
} from '../components/HistoryTable';
import {
  useEnergyReport,
  inferEnergyMapping,
  mappingToParameterCodes,
  energyPointsToRows,
} from '../hooks/useEnergyReport';

const { Title, Text } = Typography;
const { RangePicker } = DatePicker;

interface EventRow {
  event_id?: number | string;
  ts?: string;
  event_kind?: string;
  severity?: string;
  edge_id?: string;
  device_id?: string;
  message?: string;
}

interface DeviceRow {
  device_id: string;
  edge_id?: string;
  device_kind?: string;
  display_name?: string | null;
  model_id?: string | null;
  enabled?: boolean;
}

interface EnergyPoint {
  ts: string;
  group_key: string;
  parameter_code: string;
  avg_value: number | null;
  min_value: number | null;
  max_value: number | null;
  first_value: number | null;
  last_value: number | null;
  energy_delta: number | null;
}

interface ThermalPoint {
  bucket_day?: string;
  ts?: string;
  device_id: string;
  parameter_code: string;
  // mode=history（M-P12-026）統一 schema：max_value / min_value / avg_value
  max_value?: number | null;
  min_value?: number | null;
  avg_value?: number | null;
  // mode=trend（cagg_thermal_daily 既有；保留向下相容）
  daily_max?: number | null;
  daily_min?: number | null;
  daily_avg?: number | null;
  value?: number | null;
}

const eventColumns: ColumnsType<EventRow> = [
  { title: '時間', dataIndex: 'ts', key: 'ts', width: 200, render: (v) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm:ss') : '-') },
  {
    title: '嚴重度',
    dataIndex: 'severity',
    key: 'severity',
    width: 100,
    render: (v: string) => {
      const color =
        v === 'critical' ? 'red' : v === 'warn' ? 'orange' : v === 'info' ? 'blue' : 'default';
      return v ? <Tag color={color}>{v}</Tag> : null;
    },
  },
  { title: '類別', dataIndex: 'event_kind', key: 'event_kind', width: 140 },
  { title: 'Edge', dataIndex: 'edge_id', key: 'edge_id', width: 160 },
  { title: '設備', dataIndex: 'device_id', key: 'device_id', width: 180 },
  { title: '訊息', dataIndex: 'message', key: 'message', ellipsis: true },
];

function pickEnergyGranularity(range: [Dayjs, Dayjs]): '15min' | 'daily' | 'monthly' {
  const days = range[1].diff(range[0], 'day', true);
  if (days <= 3) return '15min';
  if (days <= 60) return 'daily';
  return 'monthly';
}

/**
 * 短期應急：依 device_id prefix 推導累計度數 metric。
 *
 * 依據 M-PM-075 §3.2（採信 M-P11-028 §2.2 SQL/curl 已驗證表）：
 *   cpm12d-*  → energy_kwh_total  （CPM-12D 主電；avg 41.3 kWh 已驗）
 *   cpm23-*   → energy_kwh_imp    （CPM-23；avg 0.8 kWh 已驗）
 *   aem_drb-* → ma_ae_imp         （AEM-DRB main A 預設；avg 283.5 kWh 已驗）
 *
 * 老王「穩定運行優先；不大幅更動」原則 — 上線後若需架構統一，另開 ADR。
 */
function inferEnergyMetric(deviceId: string | undefined): string {
  if (!deviceId) return 'energy_kwh_total';
  if (deviceId.startsWith('cpm12d-')) return 'energy_kwh_total';
  if (deviceId.startsWith('cpm23-')) return 'energy_kwh_imp';
  if (deviceId.startsWith('aem_drb-')) return 'ma_ae_imp';
  // 未知 prefix → fallback；後續可加新 device_kind support
  return 'energy_kwh_total';
}

/**
 * V2-final 報表頁
 * 對接：/v1/reports/events（事件） / /v1/reports/energy（能量 MVP） / /v1/reports/thermal（熱像 MVP）
 *
 * T-P11-006 MVP（2026-04-24 P11 fork session 4）：
 * - Energy Tab: 區間用電 kWh 折線 + 總 kWh
 * - Thermal Tab: daily avg/max/min 溫度折線 + 最高/最低/平均摘要
 * 進階（delete scope）：功率因數、多軸、即時刷新、CSV export、16x4 熱點細節
 */
export default function Reports() {
  // 共用時段 state（AC 2 切 Tab 不重置）
  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs().subtract(24, 'hour'), dayjs()]);

  // 設備清單（一次載入，各 Tab 共用）
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);

  // Events Tab
  const [events, setEvents] = useState<EventRow[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);

  // Energy Tab
  const [energyDevice, setEnergyDevice] = useState<string | undefined>();
  const [energyPoints, setEnergyPoints] = useState<EnergyPoint[]>([]);
  const [energyLoading, setEnergyLoading] = useState(false);
  const [energyError, setEnergyError] = useState<string | undefined>();
  const [energyQueriedRange, setEnergyQueriedRange] = useState<[Dayjs, Dayjs] | null>(null);
  // T-Reports-001 §AC 2.3 Energy Tab 新狀態
  const [energyGranularity, setEnergyGranularity] = useState<Granularity>('15min');
  const [energyViewMode, setEnergyViewMode] = useState<'device' | 'circuit'>('device');
  const [energyCircuitId, setEnergyCircuitId] = useState<string | undefined>();
  const [energyHistoryRange, setEnergyHistoryRange] = useState<[Dayjs, Dayjs] | null>(null);

  // Thermal Tab
  const [thermalDevice, setThermalDevice] = useState<string | undefined>();
  const [thermalPoints, setThermalPoints] = useState<ThermalPoint[]>([]);
  const [thermalLoading, setThermalLoading] = useState(false);
  const [thermalError, setThermalError] = useState<string | undefined>();
  const [thermalQueriedRange, setThermalQueriedRange] = useState<[Dayjs, Dayjs] | null>(null);
  // T-Reports-001 §AC 2.4 thermal granularity selector
  // 當前 backend 只支援 daily（cagg_thermal_daily）；5min/15min/1hr 待 P12 backend 擴 cagg
  const [thermalGranularity, setThermalGranularity] = useState<Granularity>('1day');

  // 載入設備清單
  useEffect(() => {
    setDevicesLoading(true);
    api.get('/admin/devices')
      .then((r) => {
        const items: DeviceRow[] = Array.isArray(r.data) ? r.data : r.data?.items ?? [];
        setDevices(items);
      })
      .catch(() => setDevices([]))
      .finally(() => setDevicesLoading(false));
  }, []);

  // T-S11C-001 AC 6（M-PM-074 §4.2）：Thermal device 下拉**改從** `/v1/admin/ir-devices`
  // 不再從 ems_device filter（811C 不註冊主表；老王明示）
  const { data: irDevicesData, isLoading: irDevicesLoading } = useIrDevices();
  const irDevices: IrDevice[] = irDevicesData ?? [];

  // T-S11C-002 Phase γ-2 + γ-4：active alert 共用查詢（30 s polling；對齊 P12 worker tick）
  const { data: activeAlertsData } = useActiveAlerts();
  const activeAlerts: AlertActive[] = activeAlertsData ?? [];

  // Phase γ-4 Edge-down banner 判斷（ADR-028 DR-028-05；M-PM-085 §3）
  const edgeDownAlerts = useMemo(() => findEdgeDownAlerts(activeAlerts), [activeAlerts]);
  // phase A 暴力假設：所有 811c_* 都歸同一 Edge（M-P12-023 §6.2 / ADR-028 DR-028-05）
  // 取 down edge 的 edge_id（若多個 Edge down 取第一個；多 Edge 模板化為未來工作）
  const suppressedEdgeId = edgeDownAlerts[0]?.edge_id ?? null;

  // 依 device_kind 分類（Energy 仍從 ems_device modbus_meter）
  const energyDevices = useMemo(
    () => devices.filter((d) => d.device_kind === 'modbus_meter' || d.device_kind === 'meter'),
    [devices],
  );

  // Thermal Tab 設備清單：用 IrDevice 結構（device_id 為 `811c_<MAC>`；display_name 顯示優先）
  // 依 T-S11C-001 AC 6：MAC 不出現前台；用 display_name 或「未命名 IR-N」
  // T-S11C-002 Phase γ-2：每筆附帶 health badge（綠 🟢 / 黃 🟡 / 橙 🟠 / 紅 🔴 / 灰 ⚪ Edge 抑制）
  const thermalDevices = useMemo(
    () => irDevices.map((d, idx) => ({
      device_id: d.device_id,
      display_name: d.display_name,
      label: irDisplayLabel(d, idx),
      isUnnamed: !((d.display_name ?? '').trim()),
      health: computeDeviceHealth(d.device_id, activeAlerts, suppressedEdgeId),
    })),
    [irDevices, activeAlerts, suppressedEdgeId],
  );

  // Thermal Tab 標題用顯示徽章
  const thermalSelectedHealth = useMemo(() => {
    return thermalDevices.find((d) => d.device_id === thermalDevice)?.health;
  }, [thermalDevices, thermalDevice]);

  // 設備下拉預設選第一個（資料回來後）
  useEffect(() => {
    if (energyDevices.length && !energyDevice) setEnergyDevice(energyDevices[0].device_id);
  }, [energyDevices, energyDevice]);
  useEffect(() => {
    if (thermalDevices.length && !thermalDevice) setThermalDevice(thermalDevices[0].device_id);
  }, [thermalDevices, thermalDevice]);

  // 用 thermalDevice 找到 displayLabel（chart title / tooltip 用；不顯示 MAC）
  const thermalSelectedLabel = useMemo(() => {
    const found = thermalDevices.find((d) => d.device_id === thermalDevice);
    return found?.label ?? thermalDevice ?? '';
  }, [thermalDevices, thermalDevice]);

  // ─────────────────────────────────────────────────────────────
  // T-Reports-001 §AC 2.3 Energy Tab — 6 metric × granularity × 視角切換
  // ─────────────────────────────────────────────────────────────

  // 是否 AEM 設備（決定是否顯示視角 toggle + circuit 下拉）
  const energyDeviceIsAem = (energyDevice ?? '').startsWith('aem_drb-');
  // 有效視角（CPM 類強制 device；AEM 用使用者選擇）
  const effectiveViewMode = energyDeviceIsAem ? energyViewMode : 'device';

  // 6 metric mapping per device + 視角 + circuit
  const energyMapping = useMemo(
    () =>
      inferEnergyMapping(
        energyDevice,
        effectiveViewMode === 'circuit' ? energyCircuitId : undefined,
      ),
    [energyDevice, effectiveViewMode, energyCircuitId],
  );

  // 6 metric → parameter_codes（送 backend）
  const energyParamCodes = useMemo(
    () => mappingToParameterCodes(energyMapping),
    [energyMapping],
  );

  // useEnergyReport hook filter（按查詢按鈕後 set energyHistoryRange 觸發 fetch）
  const energyReportFilter = useMemo(() => {
    if (!energyDevice || !energyHistoryRange || energyParamCodes.length === 0) return null;
    return {
      granularity: energyGranularity,
      parameter_codes: energyParamCodes,
      circuit_id: effectiveViewMode === 'circuit' ? energyCircuitId : undefined,
      device_ids: [energyDevice],
      from_ts: energyHistoryRange[0].toISOString(),
      to_ts: energyHistoryRange[1].toISOString(),
    };
  }, [energyDevice, energyHistoryRange, energyParamCodes, energyGranularity, effectiveViewMode, energyCircuitId]);

  const { data: energyReportData, isLoading: energyHistoryLoading } = useEnergyReport(
    energyReportFilter,
  );
  const energyHistoryRows: HistoryRow[] = useMemo(() => {
    if (!energyReportData) return [];
    return energyPointsToRows(energyReportData.points, energyMapping);
  }, [energyReportData, energyMapping]);

  // 6 column 老王指定順序（[[M-PM-092]] §一 採納版）
  const energyColumns: HistoryColumnSpec<HistoryRow>[] = useMemo(
    () => [
      { key: 'voltage', title: '電壓', unit: 'V', precision: 1, width: 90 },
      { key: 'frequency', title: '頻率', unit: 'Hz', precision: 2, width: 90 },
      { key: 'current', title: '電流', unit: 'A', precision: 2, width: 90 },
      { key: 'power_total', title: '總功率', unit: 'W', precision: 0, width: 100 },
      { key: 'power_factor', title: '功率因數', precision: 3, width: 100 },
      { key: 'energy_kwh', title: '累積用電', unit: 'kWh', precision: 3, width: 110 },
    ],
    [],
  );

  // AEM 26 路選項（主 A/B 各 1 + 子迴路各 12 = 26）
  // 老王 2026-05-04 chat：「Ma & Mb 也必須列入迴路選項之中」
  const aemCircuitOptions = useMemo(
    () => {
      const opts: { value: string; label: string }[] = [];
      opts.push({ value: 'ma', label: 'ma（主 A 排）' });
      for (let i = 1; i <= 12; i++) opts.push({ value: `ba${i}`, label: `ba${i}（A 排第 ${i} 路）` });
      opts.push({ value: 'mb', label: 'mb（主 B 排）' });
      for (let i = 1; i <= 12; i++) opts.push({ value: `bb${i}`, label: `bb${i}（B 排第 ${i} 路）` });
      return opts;
    },
    [],
  );

  // T-Reports-001 §AC 2.3 granularity options（穩定 reference 避免 inline array 觸發 ant-d Select 重 mount 時 displayed label 卡舊）
  // 老王 2026-05-04 chat 補校正：「下拉選單顯示沒連動一起變更顯示」
  const energyGranularityOptions = useMemo(
    () => [
      { value: '5min', label: '5min' },
      { value: '15min', label: '15min' },
      { value: '1hr', label: '1hr' },
      { value: '1day', label: '1day' },
    ],
    [],
  );

  // T-Reports-001 §AC 2.4 thermal granularity options
  // M-P12-026 thermal endpoint 已支援 mode=history granularity 5min/15min/1hr/1day（M-PM-101 §四 Bug 5 修；解封）
  const thermalGranularityOptions = useMemo(
    () => [
      { value: '5min', label: '5min' },
      { value: '15min', label: '15min' },
      { value: '1hr', label: '1hr' },
      { value: '1day', label: '1day' },
    ],
    [],
  );

  // ========== Events ==========
  const fetchEvents = async () => {
    setEventsLoading(true);
    try {
      const res = await api.get('/reports/events', {
        params: {
          from_ts: range[0].toISOString(),
          to_ts: range[1].toISOString(),
          limit: 500,
        },
      });
      const items = Array.isArray(res.data) ? res.data : res.data?.items ?? [];
      setEvents(items);
    } catch (e: any) {
      message.error(`載入失敗：${e.message}`);
      setEvents([]);
    } finally {
      setEventsLoading(false);
    }
  };

  // ========== Energy ==========
  const fetchEnergy = async () => {
    if (!energyDevice) {
      setEnergyError('請先選擇設備');
      return;
    }
    setEnergyLoading(true);
    setEnergyError(undefined);
    const queriedRange: [Dayjs, Dayjs] = [range[0], range[1]];
    try {
      const gran = pickEnergyGranularity(queriedRange);
      // 動態 metric mapping (M-PM-075 §3.1 / 修 M-P11-028 升報的 UI 預設 query mismatch)
      const energyMetric = inferEnergyMetric(energyDevice);
      const res = await api.get('/reports/energy', {
        params: {
          granularity: gran,
          group_by: 'device',
          from_ts: queriedRange[0].toISOString(),
          to_ts: queriedRange[1].toISOString(),
          parameter_code: energyMetric,
        },
      });
      const allPoints: EnergyPoint[] = res.data?.points ?? [];
      // group_by=device 回傳所有 device；本 Tab 只取選中的一個
      setEnergyPoints(allPoints.filter((p) => p.group_key === energyDevice));
      setEnergyQueriedRange(queriedRange);
    } catch (e: any) {
      setEnergyError(e.response?.data?.detail ?? e.message ?? '載入失敗');
      setEnergyPoints([]);
    } finally {
      setEnergyLoading(false);
    }
  };

  // ========== Thermal ==========
  const fetchThermal = async () => {
    if (!thermalDevice) {
      setThermalError('請先選擇設備');
      return;
    }
    setThermalLoading(true);
    setThermalError(undefined);
    const queriedRange: [Dayjs, Dayjs] = [range[0], range[1]];
    try {
      // M-P12-026 thermal endpoint mode=history + granularity 5min/15min/1hr/1day
      // M-P12-027 Bug 7：補 max_coord_row / max_coord_col 兩 metric（5/4 凌晨後 worker 部署生效）
      // FastAPI Query(List[str]) repeat-key 序列化（同 useEnergyReport pattern）
      const params = new URLSearchParams();
      params.append('mode', 'history');
      params.append('granularity', thermalGranularity);
      ['max_temp', 'min_temp', 'avg_temp', 'max_coord_row', 'max_coord_col'].forEach((c) =>
        params.append('parameter_codes', c),
      );
      params.append('device_ids', thermalDevice);
      params.append('from_ts', queriedRange[0].toISOString());
      params.append('to_ts', queriedRange[1].toISOString());
      const res = await api.get(`/reports/thermal?${params.toString()}`);
      const items: ThermalPoint[] = res.data?.items ?? [];
      setThermalPoints(items);
      setThermalQueriedRange(queriedRange);
    } catch (e: any) {
      setThermalError(e.response?.data?.detail ?? e.message ?? '載入失敗');
      setThermalPoints([]);
    } finally {
      setThermalLoading(false);
    }
  };

  // 首次載入 events（對齊原行為）
  useEffect(() => {
    fetchEvents();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ==== Energy chart/summary 預處理 ====
  const energyChartData = useMemo(
    () =>
      energyPoints.map((p) => ({
        ts: dayjs(p.ts).format('MM-DD HH:mm'),
        kWh: p.energy_delta,
      })),
    [energyPoints],
  );
  const totalKwh = useMemo(
    () => energyPoints.reduce((s, p) => s + (p.energy_delta ?? 0), 0),
    [energyPoints],
  );

  // ==== Thermal chart/summary 預處理 ====
  const thermalChartData = useMemo(() => {
    const byDay = new Map<string, { ts: string; avg?: number; max?: number; min?: number }>();
    thermalPoints.forEach((p) => {
      const key = p.bucket_day ?? '';
      const e = byDay.get(key) ?? { ts: key };
      if (p.parameter_code === 'avg_temp' && p.daily_avg != null) e.avg = p.daily_avg;
      if (p.parameter_code === 'max_temp' && p.daily_max != null) e.max = p.daily_max;
      if (p.parameter_code === 'min_temp' && p.daily_min != null) e.min = p.daily_min;
      byDay.set(key, e);
    });
    return Array.from(byDay.values())
      .filter((e) => e.ts)
      .sort((a, b) => a.ts.localeCompare(b.ts))
      .map((e) => ({ ts: dayjs(e.ts).format('MM-DD'), avg: e.avg, max: e.max, min: e.min }));
  }, [thermalPoints]);

  // T-Reports-001 §AC 2.4：thermal Alert history（事件 marker 對齊用）
  // 取當前選中 device + 查詢區間的 alert history events；前端 floor 到 day 與 thermal row 對齊
  const thermalAlertHistoryFilter = useMemo(() => {
    if (!thermalDevice || !thermalQueriedRange) return undefined;
    return {
      device_id: thermalDevice,
      since: thermalQueriedRange[0].toISOString(),
      until: thermalQueriedRange[1].toISOString(),
      limit: 500,
    };
  }, [thermalDevice, thermalQueriedRange]);
  const { data: thermalAlertHistoryData } = useAlertHistory(thermalAlertHistoryFilter ?? {});
  const thermalAlertHistory: AlertHistoryEvent[] = thermalAlertHistoryFilter
    ? thermalAlertHistoryData ?? []
    : [];

  // T-Reports-001 §AC 2.4 + Bug 5/7 修：thermal HistoryTable rows
  // M-P12-026 mode=history schema：max_value / min_value / avg_value（5min/15min/1hr/1day 統一）
  // M-P12-027 Bug 7：max_coord_row / max_coord_col last_value 收斂三欄同值，取 avg_value 取整
  // group by ts（5min/15min/1hr 走 trx_reading bucket；1day 走 cagg；ts/bucket_day 都接受）
  const thermalHistoryRows = useMemo<HistoryRow[]>(() => {
    if (!thermalPoints.length) return [];

    // group thermalPoints by ts → 每 bucket 收 max/min/avg + max_coord
    const byBucket = new Map<
      string,
      {
        ts: string;
        daily_max: number | null;
        daily_min: number | null;
        daily_avg: number | null;
        max_coord_row: number | null;
        max_coord_col: number | null;
      }
    >();
    thermalPoints.forEach((p) => {
      const key = p.ts ?? p.bucket_day ?? '';
      if (!key) return;
      const existing =
        byBucket.get(key) ?? {
          ts: key,
          daily_max: null,
          daily_min: null,
          daily_avg: null,
          max_coord_row: null,
          max_coord_col: null,
        };
      // mode=history 用 max_value / min_value / avg_value；mode=trend 用 daily_*（fallback）
      const v_max = p.max_value ?? p.daily_max;
      const v_min = p.min_value ?? p.daily_min;
      const v_avg = p.avg_value ?? p.daily_avg;
      if (p.parameter_code === 'max_temp' && v_max != null) existing.daily_max = v_max;
      if (p.parameter_code === 'min_temp' && v_min != null) existing.daily_min = v_min;
      if (p.parameter_code === 'avg_temp' && v_avg != null) existing.daily_avg = v_avg;
      // Bug 7（M-P12-027）：max_coord_row / col 三欄同值（last_value 收斂），取 avg_value
      if (p.parameter_code === 'max_coord_row' && p.avg_value != null)
        existing.max_coord_row = p.avg_value;
      if (p.parameter_code === 'max_coord_col' && p.avg_value != null)
        existing.max_coord_col = p.avg_value;
      byBucket.set(key, existing);
    });

    // alert events group by day floor（事件 marker 對齊；非 5min granularity 也可看 day-level events）
    const eventsByDay = new Map<string, AlertHistoryEvent[]>();
    thermalAlertHistory.forEach((e) => {
      const dayKey = dayjs(e.ts).format('YYYY-MM-DD');
      const arr = eventsByDay.get(dayKey) ?? [];
      arr.push(e);
      eventsByDay.set(dayKey, arr);
    });

    return Array.from(byBucket.values()).map((row) => {
      const dayKey = dayjs(row.ts).format('YYYY-MM-DD');
      // Bug 7（M-P12-027）：5/4 凌晨 worker 部署後 trx_reading 才有 max_coord_row/col；之前歷史 row 仍 null（顯「—」是預期）
      const maxCoord =
        row.max_coord_row != null && row.max_coord_col != null
          ? { row: Math.round(row.max_coord_row), col: Math.round(row.max_coord_col) }
          : null;
      return {
        ts: row.ts,
        daily_max: row.daily_max,
        daily_min: row.daily_min,
        daily_avg: row.daily_avg,
        max_coord: maxCoord,
        events: eventsByDay.get(dayKey) ?? [],
      } as HistoryRow;
    });
  }, [thermalPoints, thermalAlertHistory]);

  // 老王指定 4 column thermal（max/min/avg + max_coord）
  const thermalColumns: HistoryColumnSpec<HistoryRow>[] = useMemo(
    () => [
      { key: 'daily_max', title: '最高溫', unit: '°C', precision: 1, width: 110 },
      { key: 'daily_min', title: '最低溫', unit: '°C', precision: 1, width: 110 },
      { key: 'daily_avg', title: '平均溫', unit: '°C', precision: 1, width: 110 },
      {
        key: 'max_coord',
        title: '最高溫座標',
        width: 130,
        render: (val) => {
          // Bug 7（M-P12-027）：max_coord = { row: 0-7, col: 0-7 } 8×8 像素中熱點位置
          // 5/4 凌晨 worker 部署前歷史 row 無 max_coord_row/col → null → 顯「—」（預期，不是 bug）
          if (val == null || typeof val !== 'object') {
            return <Text type="secondary" style={{ fontSize: 11 }}>—</Text>;
          }
          const v = val as { row?: number; col?: number };
          if (v.row == null || v.col == null) {
            return <Text type="secondary" style={{ fontSize: 11 }}>—</Text>;
          }
          return (
            <Text style={{ fontFamily: 'monospace' }}>
              ({v.row}, {v.col})
            </Text>
          );
        },
      },
    ],
    [],
  );

  const thermalSummary = useMemo(() => {
    const avgs = thermalPoints
      .filter((p) => p.parameter_code === 'avg_temp')
      .map((p) => p.daily_avg)
      .filter((v): v is number => v != null);
    const maxes = thermalPoints
      .filter((p) => p.parameter_code === 'max_temp')
      .map((p) => p.daily_max)
      .filter((v): v is number => v != null);
    const mins = thermalPoints
      .filter((p) => p.parameter_code === 'min_temp')
      .map((p) => p.daily_min)
      .filter((v): v is number => v != null);
    return {
      max: maxes.length ? Math.max(...maxes) : null,
      min: mins.length ? Math.min(...mins) : null,
      avg: avgs.length ? avgs.reduce((a, b) => a + b, 0) / avgs.length : null,
    };
  }, [thermalPoints]);

  // ==== Render 輔助 ====
  const renderRange = () => (
    <RangePicker
      showTime
      value={range}
      onChange={(v) => v && v[0] && v[1] && setRange([v[0], v[1]])}
    />
  );

  return (
    <div>
      <Title level={3} style={{ marginTop: 0 }}>報表</Title>
      <Tabs
        defaultActiveKey="events"
        items={[
          {
            key: 'events',
            label: '事件 Events',
            children: (
              <>
                <Space style={{ marginBottom: 16 }}>
                  {renderRange()}
                  <Button type="primary" icon={<ReloadOutlined />} onClick={fetchEvents}>
                    查詢
                  </Button>
                </Space>
                <Table<EventRow>
                  columns={eventColumns}
                  dataSource={events}
                  rowKey={(r) => String(r.event_id ?? `${r.ts}-${r.edge_id}-${r.device_id}`)}
                  loading={eventsLoading}
                  size="small"
                  pagination={{ pageSize: 20 }}
                />
              </>
            ),
          },
          {
            key: 'energy',
            label: '能量 Energy',
            children: (
              <>
                <Space style={{ marginBottom: 16 }} wrap>
                  {renderRange()}
                  <Select
                    style={{ minWidth: 220 }}
                    placeholder={devicesLoading ? '載入設備中…' : '選擇設備'}
                    value={energyDevice}
                    onChange={(v) => {
                      setEnergyDevice(v);
                      // 切設備時 reset circuit / 視角（若新設備非 AEM 則強制 device 視角）
                      const isAem = (v ?? '').startsWith('aem_drb-');
                      if (!isAem) {
                        setEnergyViewMode('device');
                        setEnergyCircuitId(undefined);
                      }
                    }}
                    options={energyDevices.map((d) => ({
                      value: d.device_id,
                      label: `${d.device_id}${d.display_name ? ' · ' + d.display_name : ''}`,
                    }))}
                    notFoundContent={devicesLoading ? <Spin size="small" /> : '無電表設備'}
                    disabled={devicesLoading}
                  />
                  {/* T-Reports-001 §AC 2.3：granularity selector（5min 起；M-P12-025 backend 擴後 enable 全選項）*/}
                  {/* 老王 2026-05-04 chat：「下拉選單顯示沒連動」→ options 用 useMemo 穩定 reference + key 強制 displayed label 重 render */}
                  <Select
                    key={`energy-gran-${energyGranularity}`}
                    style={{ width: 120 }}
                    value={energyGranularity}
                    onChange={(v) => setEnergyGranularity(v)}
                    options={energyGranularityOptions}
                  />
                  {/* T-Reports-001 §AC 2.3：視角切換 toggle（CPM 類強制 device；AEM 顯示）*/}
                  <Radio.Group
                    value={effectiveViewMode}
                    onChange={(e) => setEnergyViewMode(e.target.value)}
                    optionType="button"
                    buttonStyle="solid"
                    disabled={!energyDeviceIsAem}
                    options={[
                      { value: 'device', label: '依設備' },
                      { value: 'circuit', label: '依迴路' },
                    ]}
                  />
                  {/* AEM 依迴路：circuit 下拉（24 路）*/}
                  {energyDeviceIsAem && effectiveViewMode === 'circuit' && (
                    <Select
                      style={{ width: 200 }}
                      placeholder="選擇迴路"
                      value={energyCircuitId}
                      onChange={setEnergyCircuitId}
                      options={aemCircuitOptions}
                      allowClear
                    />
                  )}
                  <Button
                    type="primary"
                    icon={<ReloadOutlined />}
                    onClick={() => {
                      // 觸發既有 LineChart fetch（FF=true 時用）+ HistoryTable hook
                      fetchEnergy();
                      setEnergyHistoryRange([range[0], range[1]]);
                    }}
                    loading={energyLoading || energyHistoryLoading}
                    disabled={!energyDevice || (energyDeviceIsAem && effectiveViewMode === 'circuit' && !energyCircuitId)}
                  >
                    查詢
                  </Button>
                </Space>
                {energyError && (
                  <Alert
                    type="error"
                    message="查詢失敗"
                    description={energyError}
                    style={{ marginBottom: 16 }}
                    showIcon
                    closable
                    onClose={() => setEnergyError(undefined)}
                  />
                )}
                <Row gutter={16} style={{ marginBottom: 16 }}>
                  <Col span={8}>
                    <Card>
                      <Statistic
                        title="時段總用電量"
                        value={totalKwh}
                        precision={3}
                        suffix="kWh"
                      />
                      {energyQueriedRange && (
                        <div style={{ color: '#888', fontSize: 12, marginTop: 8 }}>
                          {energyQueriedRange[0].format('YYYY-MM-DD HH:mm')} ~{' '}
                          {energyQueriedRange[1].format('YYYY-MM-DD HH:mm')}
                          {' · '}
                          {/* Bug 1 修（M-PM-099 §一）：用 selector state 即時連動，不用 range 推導 snapshot */}
                          {energyGranularity} 粒度
                          {' · '}
                          {energyHistoryRows.length || energyPoints.length} 點
                        </div>
                      )}
                    </Card>
                  </Col>
                </Row>
                {/* T-Reports-001 §AC 2.1：折線圖 feature flag 隱藏；保留代碼供分析比對啟用 */}
                {FF_REPORTS_LINECHART_ENABLED && (
                  <Card title="用電趨勢（分析比對）" size="small">
                    {energyLoading ? (
                      <div style={{ textAlign: 'center', padding: 60 }}>
                        <Spin />
                      </div>
                    ) : energyChartData.length === 0 ? (
                      <Empty description={energyQueriedRange ? '時段內無資料' : '請按「查詢」載入資料'} />
                    ) : (
                      <ResponsiveContainer width="100%" height={320}>
                        <LineChart data={energyChartData} margin={{ top: 8, right: 24, left: 0, bottom: 8 }}>
                          <CartesianGrid strokeDasharray="3 3" />
                          <XAxis dataKey="ts" />
                          <YAxis label={{ value: 'kWh', angle: -90, position: 'insideLeft' }} />
                          <Tooltip
                            formatter={(v) => [typeof v === 'number' ? `${v.toFixed(3)} kWh` : '—', '用電']}
                          />
                          <Line type="monotone" dataKey="kWh" stroke="#4caf50" strokeWidth={2} dot={false} />
                        </LineChart>
                      </ResponsiveContainer>
                    )}
                  </Card>
                )}
                {/* T-Reports-001 §AC 2.3：HistoryTable 6 column 老王指定順序 */}
                {/* AEM「依設備」視角：默認顯示主 A 排（ma_*）6 metric；註腳提示 ma/mb 兩排 */}
                {energyDeviceIsAem && effectiveViewMode === 'device' && (
                  <Alert
                    type="info"
                    showIcon
                    style={{ marginTop: 16 }}
                    message="AEM-DRB1 為 24 路盤式電表（A 排 ba1~ba12 + B 排 bb1~bb12）"
                    description="「依設備」視角默認顯示主 A 排 (ma_*) 6 metric；切「依迴路」可選 ba1~ba12（繼承 ma_v_avg / ma_freq）或 bb1~bb12（繼承 mb_v_avg / mb_freq）。"
                  />
                )}
                {/* AEM「依迴路」未選 circuit：提示 */}
                {energyDeviceIsAem && effectiveViewMode === 'circuit' && !energyCircuitId && (
                  <Alert
                    type="info"
                    showIcon
                    style={{ marginTop: 16 }}
                    message="請選擇迴路"
                    description="AEM-DRB1 共 24 個迴路（ba1~ba12 → 繼承 ma_v_avg / ma_freq；bb1~bb12 → 繼承 mb_v_avg / mb_freq）；選擇後按「查詢」載入該迴路履歷。"
                  />
                )}
                {/* CPM 類 + AEM 任何視角（依設備 ma_* / 依迴路已選 circuit）：HistoryTable 6 column */}
                {/* 老王 2026-05-04 chat 補校正「下拉選單顯示沒連動」→ HistoryTable + 內部 Tag 加 key 強制 re-mount when granularity 變動 */}
                {(!energyDeviceIsAem || effectiveViewMode === 'device' || (effectiveViewMode === 'circuit' && energyCircuitId)) && (
                  <HistoryTable
                    key={`energy-htbl-${energyGranularity}-${energyDevice}-${energyCircuitId ?? ''}`}
                    columns={energyColumns}
                    data={energyHistoryRows}
                    loading={energyHistoryLoading}
                    granularity={energyGranularity}
                    emptyText={energyHistoryRange ? '時段內無資料' : '請按「查詢」載入資料'}
                    title={
                      <Space>
                        <span>
                          用電履歷列表 — {energyDevice ?? '尚未選擇設備'}
                          {energyDeviceIsAem && effectiveViewMode === 'circuit' && energyCircuitId
                            ? ` · ${energyCircuitId}`
                            : ''}
                        </span>
                        <Tag key={`energy-gran-tag-${energyGranularity}`} color="blue">{energyGranularity}</Tag>
                        {effectiveViewMode === 'circuit' && energyCircuitId && (
                          <Tag color="purple">依迴路</Tag>
                        )}
                      </Space>
                    }
                  />
                )}
                {/* 5min/1hr 路徑首尾值 null 提示（M-P12-025 §7.2）*/}
                {(energyGranularity === '5min' || energyGranularity === '1hr') &&
                  energyHistoryRows.length > 0 && (
                    <Alert
                      type="info"
                      showIcon
                      style={{ marginTop: 12 }}
                      message="5min / 1hr 路徑：累積用電 (energy_kwh) 顯示 avg_value（first/last/energy_delta=null）"
                      description="累積能量差通常 15min+ 粒度才精確（DLC backlog）；如需精確累計差請切 15min 或 1day。"
                    />
                  )}
              </>
            ),
          },
          {
            key: 'thermal',
            label: '熱像 Thermal',
            children: (
              <>
                {/* T-S11C-002 Phase γ-4 Edge-down banner（ADR-028 §3 抑制 UX）*/}
                {edgeDownAlerts.length > 0 && (
                  <Alert
                    type="error"
                    showIcon
                    style={{ marginBottom: 16 }}
                    message={
                      <span>
                        ⚠️ Edge 主機{' '}
                        <Tag color="red">
                          {edgeDownAlerts.map((a) => a.edge_id).filter(Boolean).join(' / ') || '未知'}
                        </Tag>{' '}
                        失聯中（最早自{' '}
                        {dayjs(
                          edgeDownAlerts
                            .map((a) => a.triggered_at)
                            .sort()[0],
                        ).format('HH:mm')}{' '}
                        起）；下游 {irDevices.filter((d) => (d.display_name ?? '').trim()).length} 顆已標記 IR 設備暫停個別告警判斷
                      </span>
                    }
                    description="此期間 IR 設備個別離線 / 推送 / 資料 / 時戳告警統一抑制，事件流 event_type='suppressed_by_edge_down' 留證；Edge 恢復後下一個 tick 自動恢復評估"
                  />
                )}
                <Space style={{ marginBottom: 16 }} wrap>
                  {renderRange()}
                  <Select
                    style={{ minWidth: 320 }}
                    placeholder={irDevicesLoading ? '載入 IR 設備中…' : '選擇 IR 設備'}
                    value={thermalDevice}
                    onChange={setThermalDevice}
                    optionLabelProp="label"
                    options={thermalDevices.map((d) => ({
                      value: d.device_id,
                      // T-S11C-001 AC 6：MAC 不出現；用 display_name 或「未命名 IR-N」
                      // T-S11C-002 Phase γ-2：附帶 health badge emoji + tooltip
                      label: (
                        <Space size={4}>
                          <Tag color={d.health.color} style={{ marginRight: 0 }} title={d.health.tooltip}>
                            {d.health.emoji} {d.health.label}
                          </Tag>
                          {d.isUnnamed ? (
                            <Tag color="orange" style={{ marginRight: 0 }}>{d.label}</Tag>
                          ) : (
                            d.label
                          )}
                        </Space>
                      ),
                    }))}
                    notFoundContent={irDevicesLoading ? <Spin size="small" /> : '無 IR 設備（請先到「IR 標籤管理」頁標記設備）'}
                    disabled={irDevicesLoading}
                  />
                  <Button
                    type="primary"
                    icon={<ReloadOutlined />}
                    onClick={fetchThermal}
                    loading={thermalLoading}
                  >
                    查詢
                  </Button>
                </Space>
                <Alert
                  type="info"
                  showIcon
                  message="熱像趨勢為 daily 聚合；建議選 1 週以上範圍以看出趨勢"
                  style={{ marginBottom: 16 }}
                />
                {thermalError && (
                  <Alert
                    type="error"
                    message="查詢失敗"
                    description={thermalError}
                    style={{ marginBottom: 16 }}
                    showIcon
                    closable
                    onClose={() => setThermalError(undefined)}
                  />
                )}
                <Row gutter={16} style={{ marginBottom: 16 }}>
                  <Col span={8}>
                    <Card>
                      <Statistic
                        title="最高溫"
                        value={thermalSummary.max ?? '—'}
                        precision={thermalSummary.max != null ? 1 : undefined}
                        suffix={thermalSummary.max != null ? '°C' : undefined}
                        valueStyle={{ color: '#d32f2f' }}
                      />
                    </Card>
                  </Col>
                  <Col span={8}>
                    <Card>
                      <Statistic
                        title="最低溫"
                        value={thermalSummary.min ?? '—'}
                        precision={thermalSummary.min != null ? 1 : undefined}
                        suffix={thermalSummary.min != null ? '°C' : undefined}
                        valueStyle={{ color: '#1976d2' }}
                      />
                    </Card>
                  </Col>
                  <Col span={8}>
                    <Card>
                      <Statistic
                        title="平均溫"
                        value={thermalSummary.avg ?? '—'}
                        precision={thermalSummary.avg != null ? 1 : undefined}
                        suffix={thermalSummary.avg != null ? '°C' : undefined}
                      />
                      {thermalQueriedRange && (
                        <div style={{ color: '#888', fontSize: 12, marginTop: 8 }}>
                          {thermalQueriedRange[0].format('YYYY-MM-DD')} ~{' '}
                          {thermalQueriedRange[1].format('YYYY-MM-DD')}
                          {' · '}
                          {thermalChartData.length} 天
                        </div>
                      )}
                    </Card>
                  </Col>
                </Row>
                {/* T-Reports-001 §AC 2.1：折線圖 feature flag 隱藏；保留代碼供分析比對啟用 */}
                {FF_REPORTS_LINECHART_ENABLED && (
                  <Card
                    title={
                      <Space>
                        <span>溫度趨勢（daily 分析比對）— {thermalSelectedLabel || '尚未選擇 IR 設備'}</span>
                        {thermalSelectedHealth && (
                          <Tag color={thermalSelectedHealth.color} title={thermalSelectedHealth.tooltip}>
                            {thermalSelectedHealth.emoji} {thermalSelectedHealth.label}
                          </Tag>
                        )}
                      </Space>
                    }
                    size="small"
                  >
                    {thermalLoading ? (
                      <div style={{ textAlign: 'center', padding: 60 }}>
                        <Spin />
                      </div>
                    ) : thermalChartData.length === 0 ? (
                      <Empty description={thermalQueriedRange ? '時段內無資料' : '請按「查詢」載入資料'} />
                    ) : (
                      <ResponsiveContainer width="100%" height={320}>
                        <LineChart data={thermalChartData} margin={{ top: 8, right: 24, left: 0, bottom: 8 }}>
                          <CartesianGrid strokeDasharray="3 3" />
                          <XAxis dataKey="ts" />
                          <YAxis label={{ value: '°C', angle: -90, position: 'insideLeft' }} />
                          <Tooltip
                            formatter={(v, name) => [
                              typeof v === 'number' ? `${v.toFixed(1)} °C` : '—',
                              name,
                            ]}
                          />
                          <Legend />
                          <Line type="monotone" dataKey="avg" name="平均" stroke="#4caf50" strokeWidth={2} dot />
                          <Line type="monotone" dataKey="max" name="最高" stroke="#d32f2f" strokeWidth={1} dot />
                          <Line type="monotone" dataKey="min" name="最低" stroke="#1976d2" strokeWidth={1} dot />
                        </LineChart>
                      </ResponsiveContainer>
                    )}
                  </Card>
                )}
                {!FF_REPORTS_LINECHART_ENABLED && (
                  <>
                    <Space style={{ marginBottom: 12 }} wrap>
                      <Text type="secondary" style={{ fontSize: 12 }}>granularity：</Text>
                      <Select
                        key={`thermal-gran-${thermalGranularity}`}
                        size="small"
                        style={{ width: 200 }}
                        value={thermalGranularity}
                        onChange={(v) => setThermalGranularity(v)}
                        options={thermalGranularityOptions}
                      />
                      <Text type="secondary" style={{ fontSize: 11 }}>
                        ⓘ 5min/15min/1hr 走 trx_reading + time_bucket；1day 走 cagg_thermal_daily（M-P12-026 backend 擴 mode=history）
                      </Text>
                    </Space>
                    <HistoryTable
                      key={`thermal-htbl-${thermalGranularity}-${thermalDevice ?? ''}`}
                      columns={thermalColumns}
                      data={thermalHistoryRows}
                      loading={thermalLoading}
                      granularity={thermalGranularity}
                      emptyText={thermalQueriedRange ? '時段內無資料' : '請按「查詢」載入資料'}
                      title={
                        <Space>
                          <span>熱像履歷列表 — {thermalSelectedLabel || '尚未選擇 IR 設備'}</span>
                          {thermalSelectedHealth && (
                            <Tag color={thermalSelectedHealth.color} title={thermalSelectedHealth.tooltip}>
                              {thermalSelectedHealth.emoji} {thermalSelectedHealth.label}
                            </Tag>
                          )}
                        </Space>
                      }
                    />
                  </>
                )}
              </>
            ),
          },
          {
            // T-S11C-002 Phase γ-3 異常履歷 Tab（M-PM-088 §2.1 採納；ADR-028 §8.3）
            key: 'alerts',
            label: 'IR 異常履歷',
            children: <AlertsHistory />,
          },
        ]}
      />
    </div>
  );
}
