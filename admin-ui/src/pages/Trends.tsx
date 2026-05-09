/**
 * Trends — 趨勢圖獨立分項（M-PM-202；老王 5/9 16:35 chat）
 *
 * scope：從報表頁抽出 chart；sidebar 新 menu 跟報表同級。
 * - 設備 + 迴路 + RangePicker + granularity selectors（reuse Reports 邏輯模板）
 * - Demand chart（P/Q/S；reuse useEnergyReport + inferDemandMapping）
 * - 用電趨勢 LineChart（總功率 power_total 隨時間）
 * - 不含列表（HistoryTable 留 Reports 頁聚焦數據查詢）
 *
 * v1.4 §51 既有架構優先：100% reuse useEnergyReport / inferEnergyMapping / inferDemandMapping
 * 不重複實作 mapping 邏輯。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Alert, Button, Card, DatePicker, Empty, Radio, Select, Space, Spin, Typography,
} from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import dayjs, { Dayjs } from 'dayjs';
import {
  CartesianGrid, Legend, Line, LineChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import api from '../services/api';
import { type Granularity } from '../components/HistoryTable';
import {
  useEnergyReport,
  inferEnergyMapping,
  mappingToParameterCodes,
  inferDemandMapping,
  demandMappingToCodes,
  type PhaseMode,
} from '../hooks/useEnergyReport';

const { Title, Text } = Typography;
const { RangePicker } = DatePicker;

interface DeviceRow {
  device_id: string;
  edge_id?: string;
  device_kind?: string;
  display_name?: string | null;
}

export default function Trends() {
  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs().subtract(24, 'hour'), dayjs()]);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [device, setDevice] = useState<string | undefined>();
  const [granularity, setGranularity] = useState<Granularity>('15min');
  const [phaseMode, setPhaseMode] = useState<PhaseMode>('3ph');
  const [viewMode, setViewMode] = useState<'device' | 'circuit'>('device');
  const [circuitId, setCircuitId] = useState<string | undefined>();
  const [queriedRange, setQueriedRange] = useState<[Dayjs, Dayjs] | null>(null);

  // 載設備清單
  useEffect(() => {
    setDevicesLoading(true);
    api.get('/admin/devices')
      .then((r) => {
        const items: DeviceRow[] = Array.isArray(r.data) ? r.data : r.data?.items ?? [];
        setDevices(items.filter((d) => d.device_kind === 'modbus_meter' || d.device_kind === 'meter'));
      })
      .catch(() => setDevices([]))
      .finally(() => setDevicesLoading(false));
  }, []);

  useEffect(() => {
    if (devices.length && !device) setDevice(devices[0].device_id);
  }, [devices, device]);

  const isAem = (device ?? '').startsWith('aem_drb-');
  const isCpm = (device ?? '').startsWith('cpm23-') || (device ?? '').startsWith('cpm12d-');
  const hasCircuit = isAem || isCpm;
  const effectiveViewMode = hasCircuit ? viewMode : 'device';

  // mappings
  const energyMapping = useMemo(
    () => inferEnergyMapping(device, effectiveViewMode === 'circuit' ? circuitId : undefined, phaseMode),
    [device, effectiveViewMode, circuitId, phaseMode],
  );
  const energyParamCodes = useMemo(() => mappingToParameterCodes(energyMapping), [energyMapping]);
  const demandMapping = useMemo(
    () => inferDemandMapping(device, effectiveViewMode === 'circuit' ? circuitId : undefined),
    [device, effectiveViewMode, circuitId],
  );
  const demandParamCodes = useMemo(() => demandMappingToCodes(demandMapping), [demandMapping]);

  // fetch
  const energyFilter = useMemo(() => {
    if (!device || !queriedRange || energyParamCodes.length === 0) return null;
    return {
      granularity, parameter_codes: energyParamCodes, device_ids: [device],
      from_ts: queriedRange[0].toISOString(), to_ts: queriedRange[1].toISOString(),
    };
  }, [device, queriedRange, energyParamCodes, granularity]);
  const { data: energyData, isLoading: energyLoading } = useEnergyReport(energyFilter);

  const demandFilter = useMemo(() => {
    if (!device || !queriedRange || demandParamCodes.length === 0) return null;
    return {
      granularity, parameter_codes: demandParamCodes, device_ids: [device],
      from_ts: queriedRange[0].toISOString(), to_ts: queriedRange[1].toISOString(),
    };
  }, [device, queriedRange, demandParamCodes, granularity]);
  const { data: demandData, isLoading: demandLoading } = useEnergyReport(demandFilter);

  // chart data prep — power_total trend (用電趨勢)
  const powerChartData = useMemo(() => {
    if (!energyData?.points?.length || !energyMapping.power_total) return [] as { ts: string; power: number | null }[];
    const map = new Map<string, number | null>();
    energyData.points.forEach((p) => {
      if (p.parameter_code === energyMapping.power_total) {
        map.set(p.ts, p.avg_value ?? p.last_value ?? null);
      }
    });
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([ts, v]) => ({
        ts: dayjs(ts).format(granularity === '1day' ? 'MM-DD' : 'MM-DD HH:mm'),
        power: v,
      }));
  }, [energyData, energyMapping, granularity]);

  // chart data prep — demand P/Q/S
  const demandChartData = useMemo(() => {
    if (!demandData?.points?.length) return [] as { ts: string; p?: number | null; q?: number | null; s?: number | null }[];
    const byTs = new Map<string, { ts: string; p?: number | null; q?: number | null; s?: number | null }>();
    demandData.points.forEach((p) => {
      const entry = byTs.get(p.ts) ?? { ts: p.ts };
      const v = p.avg_value ?? p.last_value ?? null;
      if (p.parameter_code === demandMapping.p) entry.p = v;
      if (p.parameter_code === demandMapping.q) entry.q = v;
      if (p.parameter_code === demandMapping.s) entry.s = v;
      byTs.set(p.ts, entry);
    });
    return Array.from(byTs.values())
      .sort((a, b) => a.ts.localeCompare(b.ts))
      .map((e) => ({
        ts: dayjs(e.ts).format(granularity === '1day' ? 'MM-DD' : 'MM-DD HH:mm'),
        p: e.p, q: e.q, s: e.s,
      }));
  }, [demandData, demandMapping, granularity]);

  const granularityOptions = useMemo(
    () => [
      { value: '5min', label: '5min' }, { value: '15min', label: '15min' },
      { value: '1hr', label: '1hr' }, { value: '1day', label: '1day' },
    ],
    [],
  );

  // AEM 40 + CPM 4 circuit options（純代號；M-PM-200 落地）
  const circuitOptions = useMemo(() => {
    if (isAem) {
      const opts: { value: string; label: string }[] = [];
      opts.push({ value: 'ma', label: 'ma' });
      for (let n = 1; n <= 3; n++) opts.push({ value: `ma${n}`, label: `ma${n}` });
      ['ba1_3', 'ba4_6', 'ba7_9', 'ba10_12'].forEach((g) => opts.push({ value: g, label: g.replace('_', '-') }));
      for (let i = 1; i <= 12; i++) opts.push({ value: `ba${i}`, label: `ba${i}` });
      opts.push({ value: 'mb', label: 'mb' });
      for (let n = 1; n <= 3; n++) opts.push({ value: `mb${n}`, label: `mb${n}` });
      ['bb1_3', 'bb4_6', 'bb7_9', 'bb10_12'].forEach((g) => opts.push({ value: g, label: g.replace('_', '-') }));
      for (let i = 1; i <= 12; i++) opts.push({ value: `bb${i}`, label: `bb${i}` });
      return opts;
    }
    if (isCpm) {
      return [
        { value: 'main', label: 'main' },
        { value: 'l1', label: 'L1' },
        { value: 'l2', label: 'L2' },
        { value: 'l3', label: 'L3' },
      ];
    }
    return [];
  }, [isAem, isCpm]);

  const hasPowerMetric = !!energyMapping.power_total;
  const hasDemandMetric = demandParamCodes.length > 0;

  return (
    <div>
      <Title level={3} style={{ marginTop: 0 }}>趨勢圖</Title>
      <Space style={{ marginBottom: 16 }} wrap>
        <RangePicker
          showTime
          value={range}
          onChange={(v) => v && v[0] && v[1] && setRange([v[0], v[1]])}
        />
        <Select
          style={{ minWidth: 220 }}
          placeholder={devicesLoading ? '載入設備中…' : '選擇設備'}
          value={device}
          onChange={(v) => {
            setDevice(v);
            setCircuitId(undefined);
            const newIsAem = (v ?? '').startsWith('aem_drb-');
            const newIsCpm = (v ?? '').startsWith('cpm23-') || (v ?? '').startsWith('cpm12d-');
            if (!newIsAem && !newIsCpm) setViewMode('device');
          }}
          options={devices.map((d) => ({
            value: d.device_id,
            label: `${d.device_id}${d.display_name ? ' · ' + d.display_name : ''}`,
          }))}
          notFoundContent={devicesLoading ? <Spin size="small" /> : '無電表設備'}
          disabled={devicesLoading}
        />
        <Select
          key={`trends-gran-${granularity}`}
          style={{ width: 120 }}
          value={granularity}
          onChange={setGranularity}
          options={granularityOptions}
        />
        <Radio.Group
          value={phaseMode}
          onChange={(e) => setPhaseMode(e.target.value)}
          optionType="button"
          buttonStyle="solid"
          options={[
            { value: '1ph', label: '1PH' },
            { value: '3ph', label: '3PH' },
          ]}
        />
        <Radio.Group
          value={effectiveViewMode}
          onChange={(e) => setViewMode(e.target.value)}
          optionType="button"
          buttonStyle="solid"
          disabled={!hasCircuit}
          options={[
            { value: 'device', label: '依設備' },
            { value: 'circuit', label: '依迴路' },
          ]}
        />
        {hasCircuit && effectiveViewMode === 'circuit' && (
          <Select
            style={{ width: 220 }}
            placeholder="選擇迴路"
            value={circuitId}
            onChange={setCircuitId}
            options={circuitOptions}
            allowClear
            showSearch
            optionFilterProp="label"
          />
        )}
        <Button
          type="primary"
          icon={<ReloadOutlined />}
          onClick={() => setQueriedRange([range[0], range[1]])}
          loading={energyLoading || demandLoading}
          disabled={!device || (hasCircuit && effectiveViewMode === 'circuit' && !circuitId)}
        >
          查詢
        </Button>
      </Space>

      {/* 用電趨勢（總功率 power_total 隨時間）*/}
      <Card
        title="用電趨勢"
        size="small"
        style={{ marginBottom: 16 }}
        extra={
          hasPowerMetric ? (
            <Text type="secondary" style={{ fontSize: 11 }}>{energyMapping.power_total}</Text>
          ) : (
            <Text type="secondary" style={{ fontSize: 11 }}>本視角無 power metric</Text>
          )
        }
      >
        {!queriedRange ? (
          <Empty description="請按「查詢」載入資料" />
        ) : !hasPowerMetric ? (
          <Empty description="本視角無 power metric" />
        ) : energyLoading ? (
          <div style={{ textAlign: 'center', padding: 60 }}><Spin /></div>
        ) : powerChartData.length === 0 ? (
          <Empty description="時段內無資料" />
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={powerChartData} margin={{ top: 8, right: 24, left: 0, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="ts" />
              <YAxis label={{ value: 'W', angle: -90, position: 'insideLeft' }} />
              <Tooltip formatter={(v) => [typeof v === 'number' ? v.toFixed(0) : '—', '總功率']} />
              <Line type="monotone" dataKey="power" name="總功率 (W)" stroke="#4caf50" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </Card>

      {/* 需量趨勢 Demand（reuse Reports 既有邏輯）*/}
      <Card
        title="需量趨勢 Demand"
        size="small"
        extra={
          hasDemandMetric ? (
            <Text type="secondary" style={{ fontSize: 11 }}>{demandParamCodes.join(' / ')}</Text>
          ) : (
            <Text type="secondary" style={{ fontSize: 11 }}>本視角無 demand metric</Text>
          )
        }
      >
        {!queriedRange ? (
          <Empty description="請按「查詢」載入資料" />
        ) : !hasDemandMetric ? (
          <Empty
            description={
              <Space direction="vertical" size={4}>
                <span>本視角 driver 未落地獨立 demand metric</span>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  子迴路 / per-phase / 小群組目前無獨立 demand；可切「主迴路 ma/mb/main」
                </Text>
              </Space>
            }
          />
        ) : demandLoading ? (
          <div style={{ textAlign: 'center', padding: 60 }}><Spin /></div>
        ) : demandChartData.length === 0 ? (
          <Empty description="時段內無 demand 資料" />
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={demandChartData} margin={{ top: 8, right: 24, left: 0, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="ts" />
              <YAxis />
              <Tooltip formatter={(v, name) => [typeof v === 'number' ? v.toFixed(1) : '—', name]} />
              <Legend />
              {demandMapping.p && (
                <Line type="monotone" dataKey="p" name="P (主動需量)" stroke="#4caf50" strokeWidth={2} dot={false} />
              )}
              {demandMapping.q && (
                <Line type="monotone" dataKey="q" name="Q (無效需量)" stroke="#1976d2" strokeWidth={2} dot={false} />
              )}
              {demandMapping.s && (
                <Line type="monotone" dataKey="s" name="S (視在需量)" stroke="#ff9800" strokeWidth={2} dot={false} />
              )}
            </LineChart>
          </ResponsiveContainer>
        )}
      </Card>

      <Alert
        type="info"
        showIcon
        style={{ marginTop: 16 }}
        message="趨勢圖頁聚焦圖表分析；數據查詢、Excel 匯出、HistoryTable 列表請使用「報表」頁。"
      />
    </div>
  );
}
