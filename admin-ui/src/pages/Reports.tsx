import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert, Button, Card, Col, DatePicker, Empty, Row, Select, Space, Spin,
  Statistic, Table, Tabs, Tag, Typography, message,
} from 'antd';
import { ReloadOutlined, DownloadOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { Dayjs } from 'dayjs';
import {
  CartesianGrid, Legend, Line, LineChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import api from '../services/api';
import { useIrDevices, irDisplayLabel, type IrDevice } from '../hooks/useIrDevices';
import { useReportExport } from '../hooks/useReportExport';
// M-PM-186 §三 UI 軌：Energy Tab 加 Edge filter（fleet 5 顆 × ~10 設備需要）；
// 對齊 ModbusDevices.tsx pattern；IR Thermal 不綁 Edge 不受影響
import { useEdges } from '../hooks/useEdges';
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
  inferDemandMapping,
  demandMappingToCodes,
  mergeDemandIntoEnergyRows,
  type PhaseMode,
  type EnergyMetricMapping,
} from '../hooks/useEnergyReport';
// M-PM-253 §二 動作 1: ECSU 下拉（取代既有實體迴路 selectors；老王 5/21 拍板）
import { useEcsuList, buildEcsuTree } from '../hooks/useEcsu';

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
  // M-PM-201 §1.1: width 200 → 160（事件 Tab 顯 YYYY-MM-DD HH:mm:ss 留少量空白即可）
  { title: '時間', dataIndex: 'ts', key: 'ts', width: 160, render: (v) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm:ss') : '-') },
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
  const [, setDevicesLoading] = useState(false);

  // Events Tab
  const [events, setEvents] = useState<EventRow[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);

  // Energy Tab
  // M-PM-253 §二 動作 1（老王 5/21 拍板「棄用實體迴路下拉」改 ECSU 下拉）
  // 既有 device-mode state 保留為向下相容（Excel 既有 column 渲染 / demand mapping）；UI 不再顯
  const [energyDevice, setEnergyDevice] = useState<string | undefined>();
  const [energyPoints, setEnergyPoints] = useState<EnergyPoint[]>([]);
  const [energyLoading, setEnergyLoading] = useState(false);
  const [energyError, setEnergyError] = useState<string | undefined>();
  const [energyQueriedRange, setEnergyQueriedRange] = useState<[Dayjs, Dayjs] | null>(null);
  // T-Reports-001 §AC 2.3 Energy Tab 新狀態
  const [energyGranularity, setEnergyGranularity] = useState<Granularity>('15min');
  const [energyViewMode] = useState<'device' | 'circuit'>('device'); // M-PM-253: deprecated fallback
  const [energyCircuitId] = useState<string | undefined>(); // M-PM-253: deprecated
  const [energyHistoryRange, setEnergyHistoryRange] = useState<[Dayjs, Dayjs] | null>(null);
  // M-PM-253 §二: energyPhaseMode deprecated（PhaseMode type 仍 import 為向下相容）
  void ({} as PhaseMode);
  // M-PM-253 §二: ECSU 下拉取代既有 selectors
  const [selectedEcsuId, setSelectedEcsuId] = useState<number | undefined>();

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

  // M-PM-111 軌 A③.2 useEdges() 已撤回（老王 5/7 chat 校正：IR 不綁 Edge）

  // T-S11C-002 Phase γ-2 + γ-4：active alert 共用查詢（30 s polling；對齊 P12 worker tick）
  const { data: activeAlertsData } = useActiveAlerts();
  const activeAlerts: AlertActive[] = activeAlertsData ?? [];

  // Phase γ-4 Edge-down banner 判斷（ADR-028 DR-028-05；M-PM-085 §3）
  const edgeDownAlerts = useMemo(() => findEdgeDownAlerts(activeAlerts), [activeAlerts]);
  // phase A 暴力假設：所有 811c_* 都歸同一 Edge（M-P12-023 §6.2 / ADR-028 DR-028-05）
  // 取 down edge 的 edge_id（若多個 Edge down 取第一個；多 Edge 模板化為未來工作）
  const suppressedEdgeId = edgeDownAlerts[0]?.edge_id ?? null;

  // M-PM-253 §二: 加 ECSU list + KW- natural sort (reuse buildEcsuTree from M-P11-E14)
  const { data: ecsuListData } = useEcsuList();
  const sortedEcsus = useMemo(() => {
    if (!ecsuListData) return [];
    // buildEcsuTree 樹狀化後 sortFn 已套 KW- natural sort; flatten 取 sorted order
    type Node = (typeof ecsuListData)[number] & { children?: Node[] };
    const tree = buildEcsuTree(ecsuListData) as Node[];
    const flat: (typeof ecsuListData) = [];
    const walk = (nodes: Node[]) => {
      nodes.forEach((n) => {
        const { children, ...rest } = n;
        flat.push(rest as (typeof ecsuListData)[number]);
        if (children) walk(children);
      });
    };
    walk(tree);
    return flat;
  }, [ecsuListData]);

  // ECSU 下拉 options（label: `KW-XX · 區域 · 名稱`；老王 5/21 截圖格式對齊）
  const ecsuSelectOptions = useMemo(
    () =>
      sortedEcsus.map((e) => ({
        value: e.ecsu_id,
        label: `${e.ecsu_code} · ${e.region ?? '—'} · ${e.ecsu_name}`,
      })),
    [sortedEcsus],
  );

  // 預設選第一個 ECSU
  useEffect(() => {
    if (sortedEcsus.length > 0 && selectedEcsuId == null) {
      setSelectedEcsuId(sortedEcsus[0].ecsu_id);
    }
  }, [sortedEcsus, selectedEcsuId]);

  // 依 device_kind 分類（Energy 仍從 ems_device modbus_meter）— 保留向下相容
  const energyDevicesAll = useMemo(
    () => devices.filter((d) => d.device_kind === 'modbus_meter' || d.device_kind === 'meter'),
    [devices],
  );
  // M-PM-253 §二: Edge filter / energyDevices 路徑 deprecated（不再 UI 顯示）
  // 既有 energyDevicesAll reference 保留為 Excel 用（excel 內 device_id 推 device_kind for per-phase column）
  const energyDevices = energyDevicesAll;
  void energyDevices;
  // M-PM-253 §二: useEdges import 保留但本 page deprecated（other tabs 可能仍用；此處 void）
  void useEdges;

  // Thermal Tab 設備清單：用 IrDevice 結構（device_id 為 `811c_<MAC>`；display_name 顯示優先）
  // 依 T-S11C-001 AC 6：MAC 不出現前台；用 display_name 或「未命名 IR-N」
  // T-S11C-002 Phase γ-2：每筆附帶 health badge（綠 🟢 / 黃 🟡 / 橙 🟠 / 紅 🔴 / 灰 ⚪ Edge 抑制）
  //
  // 老王 5/7 chat 校正：「811C 不要綁死在某一顆 Edge 上面；存活判定認 MAC + 安裝位置標籤」
  // → M-PM-111 軌 A③.2 OptGroup by edge_id 已撤回；改回平鋪 device 下拉
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

  // 平鋪 device options（依 device_id MAC + 顯示 display_name 安裝位置標籤）
  const thermalOptions = useMemo(
    () =>
      thermalDevices.map((d) => ({
        value: d.device_id,
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
      })),
    [thermalDevices],
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
  // M-PM-198 §3.3 / §3.4 CPM 也加 per-phase「依迴路」（L1/L2/L3）
  const energyDeviceIsCpm =
    (energyDevice ?? '').startsWith('cpm23-') ||
    (energyDevice ?? '').startsWith('cpm12d-');
  // 有視角切換能力的設備（AEM 或 CPM）才 enable Radio.Group
  const energyDeviceHasCircuit = energyDeviceIsAem || energyDeviceIsCpm;
  // 有效視角（無 sub-circuit 設備強制 device；其他用使用者選擇）
  const effectiveViewMode = energyDeviceHasCircuit ? energyViewMode : 'device';

  // M-PM-253 §二: ECSU 模式 FIXED mapping（不再 per-device infer）
  // backend mapping layer (M-P12-061 §3.2) 對 binding 自動 map circuit_code → mapped parameter_code
  // → frontend 傳 superset 確保 backend filter ∩ 全 binding mapped param
  //
  // ECSU_PARAM_SUPERSET 對齊 device_circuits.py map_*_param mapping table:
  //   cpm12d/cpm23 main: power_total, energy_kwh_imp
  //   aem_drb main:       ma_p_sum, mb_p_sum, ma_ae_imp, mb_ae_imp
  //   aem_drb branch:     ba1-12_p / bb1-12_p / ba1-12_ae_imp / bb1-12_ae_imp
  //   aem_drb three_phase: ba1_3_p_sum...bb10_12_p_sum / 同 _ae_imp
  // total ~60 codes; backend 自動 filter binding ∩ user_params
  const ECSU_PARAM_SUPERSET = useMemo(() => [
    'power_total', 'energy_kwh_imp',
    'ma_p_sum', 'mb_p_sum', 'ma_ae_imp', 'mb_ae_imp',
    ...Array.from({ length: 12 }, (_, i) => `ba${i + 1}_p`),
    ...Array.from({ length: 12 }, (_, i) => `bb${i + 1}_p`),
    ...Array.from({ length: 12 }, (_, i) => `ba${i + 1}_ae_imp`),
    ...Array.from({ length: 12 }, (_, i) => `bb${i + 1}_ae_imp`),
    'ba1_3_p_sum', 'ba4_6_p_sum', 'ba7_9_p_sum', 'ba10_12_p_sum',
    'bb1_3_p_sum', 'bb4_6_p_sum', 'bb7_9_p_sum', 'bb10_12_p_sum',
    'ba1_3_ae_imp', 'ba4_6_ae_imp', 'ba7_9_ae_imp', 'ba10_12_ae_imp',
    'bb1_3_ae_imp', 'bb4_6_ae_imp', 'bb7_9_ae_imp', 'bb10_12_ae_imp',
  ], []);

  // M-PM-253 §二: ECSU 模式 mapping (Excel column rendering reuse)
  // backend 自動聚合 → 只 power_total 與 energy_kwh_imp 對 ECSU 有 reliable 意義
  // voltage / frequency / current / power_factor 對 ECSU 無 mapping → null
  const energyMapping: EnergyMetricMapping = useMemo(() => ({
    voltage: null,
    frequency: null,
    current: null,
    power_total: 'power_total',
    power_factor: null,
    energy_kwh: 'energy_kwh_imp',
  }), []);

  // ECSU 模式不再用 inferEnergyMapping/mappingToParameterCodes
  // 保留變數 reference 為 backward compat（unused）
  void inferEnergyMapping;
  void mappingToParameterCodes;
  void ECSU_PARAM_SUPERSET; // ECSU 模式直接傳 superset；不再 mappingToParameterCodes

  // useEnergyReport hook filter — M-PM-253 §二: ecsu_id 路徑
  const energyReportFilter = useMemo(() => {
    if (!selectedEcsuId || !energyHistoryRange) return null;
    return {
      granularity: energyGranularity,
      parameter_codes: ECSU_PARAM_SUPERSET,
      ecsu_id: selectedEcsuId,
      from_ts: energyHistoryRange[0].toISOString(),
      to_ts: energyHistoryRange[1].toISOString(),
    };
  }, [selectedEcsuId, energyHistoryRange, energyGranularity, ECSU_PARAM_SUPERSET]);

  const { data: energyReportData, isLoading: energyHistoryLoading } = useEnergyReport(
    energyReportFilter,
  );
  // M-PM-203：energyHistoryRows 拆兩階段（raw → merged with demand_p）
  // raw：原 energyPointsToRows 結果；後段 useMemo 合 demand_p
  const energyHistoryRowsRaw: HistoryRow[] = useMemo(() => {
    if (!energyReportData) return [];
    return energyPointsToRows(energyReportData.points, energyMapping);
  }, [energyReportData, energyMapping]);
  // 註：實際 energyHistoryRows 在 demandReportData 之後定義（line ↓）；
  //     既有 reference 跟先前一致；行為僅多 demand_p 欄位

  // ─────────────────────────────────────────────────────────────
  // M-PM-196 §一 / M-PM-198 同 deploy：Demand chart 對接
  // - reuse useEnergyReport hook（同一 endpoint；只 parameter_codes 不同）
  // - mapping 來源 inferDemandMapping（device + circuit）
  // - chart 顯三條線：P/Q/S
  // ─────────────────────────────────────────────────────────────
  // M-PM-253 §二: demand chart 同 ECSU 模式（Energy Tab 內 demand_p column）
  // backend mapping layer 對 binding 不 include demand_p（M-P12-061 mapping 只 energy + power）
  // → demand 對 ECSU 模式無 backend mapping → demand chart 對 ECSU 不顯數據（null）
  // 對齊老王 5/21 拍板 1「Demand Tab 不改」精神（Demand Tab 已不在；demand_p column 在 Energy Tab 內顯空 OK）
  const demandMapping = useMemo(
    () => inferDemandMapping(undefined, undefined),
    [],
  );
  const demandParamCodes = useMemo(
    () => demandMappingToCodes(demandMapping),
    [demandMapping],
  );
  // M-PM-253 §二: 暫不 fetch demand（無 backend mapping 對 ECSU；對齊拍板）
  const demandReportFilter = null;
  void demandParamCodes;
  // M-PM-202: chart 已抽至 /trends 頁；本頁仍 fetch demand 用於 HistoryTable demand_p column（M-PM-203）
  const { data: demandReportData } = useEnergyReport(demandReportFilter);

  // M-PM-203: energyHistoryRows 合 demand_p column
  // - reuse mergeDemandIntoEnergyRows（hook 提供）
  // - demand p 對應 row.ts 找；無 → null（HistoryTable render 顯「—」）
  const energyHistoryRows: HistoryRow[] = useMemo(
    () =>
      mergeDemandIntoEnergyRows(
        energyHistoryRowsRaw,
        demandReportData?.points ?? [],
        demandMapping,
      ),
    [energyHistoryRowsRaw, demandReportData, demandMapping],
  );

  // 7 column 老王指定順序（[[M-PM-092]] §一 + [[M-PM-203]] 加需量）
  // M-PM-203: 「需量 (W)」加在「累積用電」之後；對接 inferDemandMapping (cpm12d demand_p_total / cpm23 demand_p_sum / aem ma/mb_p_dm)
  const energyColumns: HistoryColumnSpec<HistoryRow>[] = useMemo(
    () => [
      { key: 'voltage', title: '電壓', unit: 'V', precision: 1, width: 90 },
      { key: 'frequency', title: '頻率', unit: 'Hz', precision: 2, width: 90 },
      { key: 'current', title: '電流', unit: 'A', precision: 2, width: 90 },
      { key: 'power_total', title: '總功率', unit: 'W', precision: 0, width: 100 },
      { key: 'power_factor', title: '功率因數', precision: 3, width: 100 },
      { key: 'energy_kwh', title: '累積用電', unit: 'kWh', precision: 1, width: 110 },
      { key: 'demand_p', title: '需量', unit: 'W', precision: 0, width: 100 },
    ],
    [],
  );

  // AEM 完整下拉項（M-PM-198 §2.1）：26 既有 + 14 新加 = 40 個
  // - 主 A/B 排：ma / mb（各 1）= 2
  // - 主 A/B 排 per-phase：ma1~ma3 / mb1~mb3（M-PM-198 §3.1；driver 軌已落地）= 6
  // - 小群組：ba1_3/ba4_6/ba7_9/ba10_12 / bb1_3/bb4_6/bb7_9/bb10_12（M-PM-198 §3.2；driver 軌已落地）= 8
  // - 分迴路：ba1~ba12 / bb1~bb12（既有）= 24
  // 老王 5/4 chat「Ma & Mb 必須列入迴路選項」+ 5/9 chat「增加 Ma1/Ma2/Ma3/Ba1-3/Ba4-6...」
  // M-PM-200: 純代號顯示（去括號 + 括號內中文）
  const aemCircuitOptions = useMemo(
    () => {
      const opts: { value: string; label: string }[] = [];
      // ─ A 排 ─
      opts.push({ value: 'ma', label: 'ma' });
      for (let n = 1; n <= 3; n++) opts.push({ value: `ma${n}`, label: `ma${n}` });
      opts.push({ value: 'ba1_3', label: 'ba1-3' });
      opts.push({ value: 'ba4_6', label: 'ba4-6' });
      opts.push({ value: 'ba7_9', label: 'ba7-9' });
      opts.push({ value: 'ba10_12', label: 'ba10-12' });
      for (let i = 1; i <= 12; i++) opts.push({ value: `ba${i}`, label: `ba${i}` });
      // ─ B 排 ─
      opts.push({ value: 'mb', label: 'mb' });
      for (let n = 1; n <= 3; n++) opts.push({ value: `mb${n}`, label: `mb${n}` });
      opts.push({ value: 'bb1_3', label: 'bb1-3' });
      opts.push({ value: 'bb4_6', label: 'bb4-6' });
      opts.push({ value: 'bb7_9', label: 'bb7-9' });
      opts.push({ value: 'bb10_12', label: 'bb10-12' });
      for (let i = 1; i <= 12; i++) opts.push({ value: `bb${i}`, label: `bb${i}` });
      return opts;
    },
    [],
  );

  // CPM 系列下拉項（M-PM-198 §2.2 / §2.3 + M-PM-200 純代號）：main + L1/L2/L3 = 4 個
  const cpmCircuitOptions = useMemo(
    () => [
      { value: 'main', label: 'main' },
      { value: 'l1', label: 'L1' },
      { value: 'l2', label: 'L2' },
      { value: 'l3', label: 'L3' },
    ],
    [],
  );

  // M-PM-253 §二: circuit options deprecated（不再顯實體迴路下拉）
  // 既有 aemCircuitOptions / cpmCircuitOptions 保留為 backward compat（Excel column 推導用）
  void aemCircuitOptions; void cpmCircuitOptions;

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
  // 老王 5/8 chat / M-PM-161 §AC 5 / M-PM-162 §4.2：「時段總用電量」= 全期累積差（last 點 - first 點）
  // 不再 sum(energy_delta)；改用累積值（last_value）first vs last 差；對齊老王讀電表面板數的直覺
  const totalKwh = useMemo(() => {
    if (energyPoints.length === 0) return 0;
    // 找出 ts 排序前後 last_value，計算累積差
    const sorted = [...energyPoints].sort((a, b) => a.ts.localeCompare(b.ts));
    const firstLast = sorted[0]?.last_value ?? sorted[0]?.avg_value ?? 0;
    const lastLast = sorted[sorted.length - 1]?.last_value ?? sorted[sorted.length - 1]?.avg_value ?? 0;
    const delta = (lastLast ?? 0) - (firstLast ?? 0);
    return delta > 0 ? delta : 0; // 防 cagg 邊界 negative；累積值不可能減少
  }, [energyPoints]);

  // M-PM-253 §二 動作 4: helper for Excel cell number formatting
  const fmtNum = (v: unknown, precision: number): string => {
    if (typeof v === 'number') return v.toFixed(precision);
    return v == null ? '' : String(v);
  };

  // M-PM-253 §二 動作 4: Excel 18 欄匯出（老王 5/21 截圖格式 + 4 拍板兌現）
  // - 區域 / 電表編號 / 名稱 / 日期 / 時間 / 平均電壓(V) / 平均電流(A) / A/b/C 電流 /
  //   平均總功率(W) / 功率因數 / 累積用電(kWh) / 頻率(Hz) / 用電量合計(度) / 電費 / 電費合計(元)
  // - A/b/C 電流：僅 aem_drb 填值（M-P11-E19 拍板 2；ECSU 模式 mapping 無 → 全顯空）
  // - 用電量合計：ECSU 期間 SUM（footer row）
  // - 電費 / 電費合計：留空（電價規則 UI 未完）
  // - 功率因數紅色 conditional format：跳過（純資料；拍板 4）
  const { exportToExcel, isExporting } = useReportExport();

  const selectedEcsuForExcel = useMemo(
    () => sortedEcsus.find((e) => e.ecsu_id === selectedEcsuId),
    [sortedEcsus, selectedEcsuId],
  );

  const handleExportEnergyExcel = useCallback(() => {
    if (!selectedEcsuForExcel || energyHistoryRows.length === 0) return;
    const ecsuCode = selectedEcsuForExcel.ecsu_code;
    const region = selectedEcsuForExcel.region ?? '';
    const ecsuName = selectedEcsuForExcel.ecsu_name;

    const fmt = (d: dayjs.Dayjs) => d.format('YYYYMMDD-HHmm');
    const safeName = `${ecsuCode}_${ecsuName}`.replace(/[/\\?*:|"<>]/g, '_');
    const filename = `用電履歷_${safeName}_${energyGranularity}_${fmt(range[0])}_至_${fmt(range[1])}.xlsx`;

    // 18 column 對齊老王 5/21 截圖
    type ExcelRow = (typeof energyHistoryRows)[number] & {
      region: string;
      ecsu_code: string;
      ecsu_name: string;
      _date: string;
      _time: string;
    };

    const enrichedRows: ExcelRow[] = energyHistoryRows.map((r) => {
      const ts = dayjs((r as { ts?: string }).ts);
      return {
        ...r,
        region,
        ecsu_code: ecsuCode,
        ecsu_name: ecsuName,
        _date: ts.isValid() ? ts.format('YYYY-MM-DD') : '',
        _time: ts.isValid() ? ts.format('HH:mm:ss') : '',
      };
    });

    exportToExcel<ExcelRow>({
      rows: enrichedRows,
      columns: [
        { key: 'region', header: '區域' },
        { key: 'ecsu_code', header: '電表編號' },
        { key: 'ecsu_name', header: '名稱' },
        { key: '_date', header: '日期' },
        { key: '_time', header: '時間' },
        { key: 'voltage', header: '平均電壓(V)', render: (r) => fmtNum((r as Record<string, unknown>).voltage, 1) },
        { key: 'current', header: '平均電流(A)', render: (r) => fmtNum((r as Record<string, unknown>).current, 2) },
        { key: 'current_a', header: 'A 電流(A)', render: () => '' /* M-P11-E19 拍板 2: ECSU 模式無 per-phase mapping; 空 */ },
        { key: 'current_b', header: 'b 電流(A)', render: () => '' },
        { key: 'current_c', header: 'C 電流(A)', render: () => '' },
        { key: 'power_total', header: '平均總功率(W)', render: (r) => fmtNum((r as Record<string, unknown>).power_total, 0) },
        { key: 'power_factor', header: '功率因數', render: (r) => fmtNum((r as Record<string, unknown>).power_factor, 3) },
        { key: 'energy_kwh', header: '累積用電(kWh)', render: (r) => fmtNum((r as Record<string, unknown>).energy_kwh, 1) },
        { key: 'frequency', header: '頻率(Hz)', render: (r) => fmtNum((r as Record<string, unknown>).frequency, 2) },
        { key: '_consumption', header: '用電量合計(度)', render: () => '' /* M-P11-E19 拍板 3: 業主自填 / SUM；frontend 暫留空 */ },
        { key: '_rate', header: '電費', render: () => '' /* 電價規則 UI 未完成；留空 */ },
        { key: '_total_fee', header: '電費合計(元)', render: () => '' /* 同 */ },
      ],
      filename,
      sheetName: 'Energy',
    });
  }, [
    selectedEcsuForExcel,
    energyHistoryRows,
    energyGranularity,
    range,
    exportToExcel,
  ]);

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
        defaultActiveKey="energy"
        items={[
          {
            key: 'energy',
            label: '用電數據 Energy',
            children: (
              <>
                <Space style={{ marginBottom: 16 }} wrap>
                  {renderRange()}
                  {/* M-PM-253 §二 動作 1（老王 5/21 拍板）：移除 Edge filter + 設備 + 1PH/3PH + 視角 + 迴路 5 selectors
                       改 ECSU Select（label: `KW-XX · 區域 · 名稱`；KW- natural sort）
                       backend force group_by=ecsu + mapping layer per-binding（M-P12-061 §3.2）*/}
                  <Select
                    style={{ minWidth: 320 }}
                    placeholder="選擇 ECSU（KW- · 區域 · 名稱）"
                    value={selectedEcsuId}
                    onChange={(v) => setSelectedEcsuId(v)}
                    options={ecsuSelectOptions}
                    showSearch
                    optionFilterProp="label"
                    notFoundContent={ecsuListData == null ? <Spin size="small" /> : '無 ECSU'}
                  />
                  {/* T-Reports-001 §AC 2.3：granularity selector（5min 起；M-P12-025 backend 擴後 enable 全選項）*/}
                  <Select
                    key={`energy-gran-${energyGranularity}`}
                    style={{ width: 120 }}
                    value={energyGranularity}
                    onChange={(v) => setEnergyGranularity(v)}
                    options={energyGranularityOptions}
                  />
                  <Button
                    type="primary"
                    icon={<ReloadOutlined />}
                    onClick={() => {
                      // 觸發既有 LineChart fetch（FF=true 時用）+ HistoryTable hook
                      fetchEnergy();
                      setEnergyHistoryRange([range[0], range[1]]);
                    }}
                    loading={energyLoading || energyHistoryLoading}
                    disabled={!selectedEcsuId}
                  >
                    查詢
                  </Button>
                  {/* M-PM-173 / M-PM-159 §AC 2-4: Excel 匯出（純前端 SheetJS）*/}
                  <Button
                    icon={<DownloadOutlined />}
                    onClick={handleExportEnergyExcel}
                    loading={isExporting}
                    disabled={!selectedEcsuId || energyHistoryRows.length === 0}
                  >
                    📥 匯出 Excel
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
                        precision={1}
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
                {/* M-PM-202: Demand chart 已抽出獨立至 /trends 頁（趨勢圖）；本頁聚焦列表查詢 */}
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
                {/* M-PM-198：AEM/CPM「依迴路」未選 circuit：提示 */}
                {energyDeviceHasCircuit && effectiveViewMode === 'circuit' && !energyCircuitId && (
                  <Alert
                    type="info"
                    showIcon
                    style={{ marginTop: 16 }}
                    message="請選擇迴路"
                    description={
                      energyDeviceIsAem
                        ? 'AEM-DRB1 共 40 個迴路項：主迴路 ma/mb（2）+ 主迴路 per-phase ma1~3/mb1~3（6）+ 小群組 ba1-3/4-6/7-9/10-12 + bb 同（8）+ 分迴路 ba/bb 1~12（24）。'
                        : 'CPM 共 4 個迴路項：主迴路（main 平均/總和）+ L1/L2/L3（A/B/C 相）。選擇後按「查詢」載入該迴路履歷。'
                    }
                  />
                )}
                {/* M-PM-198：HistoryTable render 條件擴 CPM；老王 5/4 chat「下拉沒連動」key 重 mount 既有保留 */}
                {(!energyDeviceHasCircuit || effectiveViewMode === 'device' || (effectiveViewMode === 'circuit' && energyCircuitId)) && (
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
                          {energyDeviceHasCircuit && effectiveViewMode === 'circuit' && energyCircuitId
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
                    style={{ minWidth: 360 }}
                    placeholder={irDevicesLoading ? '載入 IR 設備中…' : '選擇 IR 設備'}
                    value={thermalDevice}
                    onChange={setThermalDevice}
                    optionLabelProp="label"
                    // 老王 5/7 chat 校正：IR 設備不綁 Edge；平鋪 device 下拉（按 MAC + 安裝位置標籤）
                    options={thermalOptions}
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
