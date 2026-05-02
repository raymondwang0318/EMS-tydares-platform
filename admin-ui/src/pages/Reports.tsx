import { useEffect, useMemo, useState } from 'react';
import {
  Alert, Button, Card, Col, DatePicker, Empty, Row, Select, Space, Spin,
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

const { Title } = Typography;
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

  // Thermal Tab
  const [thermalDevice, setThermalDevice] = useState<string | undefined>();
  const [thermalPoints, setThermalPoints] = useState<ThermalPoint[]>([]);
  const [thermalLoading, setThermalLoading] = useState(false);
  const [thermalError, setThermalError] = useState<string | undefined>();
  const [thermalQueriedRange, setThermalQueriedRange] = useState<[Dayjs, Dayjs] | null>(null);

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

  // 依 device_kind 分類（Energy 仍從 ems_device modbus_meter）
  const energyDevices = useMemo(
    () => devices.filter((d) => d.device_kind === 'modbus_meter' || d.device_kind === 'meter'),
    [devices],
  );

  // Thermal Tab 設備清單：用 IrDevice 結構（device_id 為 `811c_<MAC>`；display_name 顯示優先）
  // 依 T-S11C-001 AC 6：MAC 不出現前台；用 display_name 或「未命名 IR-N」
  const thermalDevices = useMemo(
    () => irDevices.map((d, idx) => ({
      device_id: d.device_id,
      display_name: d.display_name,
      label: irDisplayLabel(d, idx),
      isUnnamed: !((d.display_name ?? '').trim()),
    })),
    [irDevices],
  );

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
      const res = await api.get('/reports/thermal', {
        params: {
          mode: 'trend',
          device_id: thermalDevice,
          from_ts: queriedRange[0].toISOString(),
          to_ts: queriedRange[1].toISOString(),
        },
      });
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
                    onChange={setEnergyDevice}
                    options={energyDevices.map((d) => ({
                      value: d.device_id,
                      label: `${d.device_id}${d.display_name ? ' · ' + d.display_name : ''}`,
                    }))}
                    notFoundContent={devicesLoading ? <Spin size="small" /> : '無電表設備'}
                    disabled={devicesLoading}
                  />
                  <Button
                    type="primary"
                    icon={<ReloadOutlined />}
                    onClick={fetchEnergy}
                    loading={energyLoading}
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
                          {pickEnergyGranularity(energyQueriedRange)} 粒度
                          {' · '}
                          {energyPoints.length} 點
                        </div>
                      )}
                    </Card>
                  </Col>
                </Row>
                <Card title="用電趨勢" size="small">
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
              </>
            ),
          },
          {
            key: 'thermal',
            label: '熱像 Thermal',
            children: (
              <>
                <Space style={{ marginBottom: 16 }} wrap>
                  {renderRange()}
                  <Select
                    style={{ minWidth: 280 }}
                    placeholder={irDevicesLoading ? '載入 IR 設備中…' : '選擇 IR 設備'}
                    value={thermalDevice}
                    onChange={setThermalDevice}
                    options={thermalDevices.map((d) => ({
                      value: d.device_id,
                      // T-S11C-001 AC 6：MAC 不出現；用 display_name 或「未命名 IR-N」
                      label: d.isUnnamed ? (
                        <Tag color="orange" style={{ marginRight: 0 }}>{d.label}</Tag>
                      ) : d.label,
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
                <Card title={`溫度趨勢（daily）— ${thermalSelectedLabel || '尚未選擇 IR 設備'}`} size="small">
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
              </>
            ),
          },
        ]}
      />
    </div>
  );
}
