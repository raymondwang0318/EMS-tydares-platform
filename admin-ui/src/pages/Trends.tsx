/**
 * Trends — 趨勢圖獨立分項（M-PM-202；老王 5/9 16:35 chat）
 *
 * M-PM-253 §二 動作 1（老王 5/21 拍板）翻新：
 * - 移除 device / circuit / viewMode / phaseMode / EdgeFilter 5 selectors
 * - 加 ECSU 下拉（reuse useEcsuList + buildEcsuTree KW- natural sort）
 * - 呼叫 /reports/energy?ecsu_id={id} force group_by=ecsu + mapping layer（M-P12-061 §3.2）
 * - power_total trend 對 ECSU 模式繼續顯（mapping layer 對 aem_drb 推 ma_p_sum/ba1_p 等）
 * - demand chart 因 backend mapping 不 cover demand_p → 對 ECSU 模式顯空（拍板 1 對齊）
 *
 * 既有 Reports.tsx 設計參考 + reuse useEnergyReport hook
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, Button, Card, DatePicker, Empty, Select, Space, Spin, Typography,
} from 'antd';
import { ReloadOutlined, CameraOutlined, FilePdfOutlined } from '@ant-design/icons';
import dayjs, { Dayjs } from 'dayjs';
import {
  CartesianGrid, Legend, Line, LineChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { type Granularity } from '../components/HistoryTable';
import { useEnergyReport } from '../hooks/useEnergyReport';
import { useEcsuList, buildEcsuTree } from '../hooks/useEcsu';
import { isEmbedded } from '../lib/embed';

const { Title, Text } = Typography;
const { RangePicker } = DatePicker;

// M-PM-253 §二 / M-PM-264 §三: ECSU 模式 parameter_codes superset（對齊 backend mapping table）
// reuse 同 Reports.tsx 的 ECSU_PARAM_SUPERSET（複製過來；未來可抽 hook 共享）
// M-PM-264 §三：補 voltage/freq/current/pf/demand variants（即使 Trends chart 只 plot power 線，
// SUPERSET 對齊 backend 7 metric mapping 避免 HTTP 422 / 對齊一致）
const ECSU_PARAM_SUPERSET = [
  // power + energy
  'power_total', 'energy_kwh_imp', 'energy_kwh_total',
  'ma_p_sum', 'mb_p_sum', 'ma_ae_imp', 'mb_ae_imp',
  ...Array.from({ length: 12 }, (_, i) => `ba${i + 1}_p`),
  ...Array.from({ length: 12 }, (_, i) => `bb${i + 1}_p`),
  ...Array.from({ length: 12 }, (_, i) => `ba${i + 1}_ae_imp`),
  ...Array.from({ length: 12 }, (_, i) => `bb${i + 1}_ae_imp`),
  'ba1_3_p_sum', 'ba4_6_p_sum', 'ba7_9_p_sum', 'ba10_12_p_sum',
  'bb1_3_p_sum', 'bb4_6_p_sum', 'bb7_9_p_sum', 'bb10_12_p_sum',
  'ba1_3_ae_imp', 'ba4_6_ae_imp', 'ba7_9_ae_imp', 'ba10_12_ae_imp',
  'bb1_3_ae_imp', 'bb4_6_ae_imp', 'bb7_9_ae_imp', 'bb10_12_ae_imp',
  // voltage / freq / current / pf / demand (M-PM-264 §三; AVG mode)
  'voltage_avg', 'voltage_ll_avg', 'ma_v_avg', 'mb_v_avg',
  'frequency', 'ma_freq', 'mb_freq',
  'current_avg', 'ma_i_avg', 'mb_i_avg',
  ...Array.from({ length: 12 }, (_, i) => `ba${i + 1}_i`),
  ...Array.from({ length: 12 }, (_, i) => `bb${i + 1}_i`),
  'ba1_3_i_avg', 'ba4_6_i_avg', 'ba7_9_i_avg', 'ba10_12_i_avg',
  'bb1_3_i_avg', 'bb4_6_i_avg', 'bb7_9_i_avg', 'bb10_12_i_avg',
  'power_factor_avg', 'ma_pf', 'mb_pf',
  ...Array.from({ length: 12 }, (_, i) => `ba${i + 1}_pf`),
  ...Array.from({ length: 12 }, (_, i) => `bb${i + 1}_pf`),
  'ba1_3_pf_avg', 'ba4_6_pf_avg', 'ba7_9_pf_avg', 'ba10_12_pf_avg',
  'bb1_3_pf_avg', 'bb4_6_pf_avg', 'bb7_9_pf_avg', 'bb10_12_pf_avg',
  'demand_p_total', 'demand_p_sum', 'ma_p_dm', 'mb_p_dm',
];

// power_total 相關 parameter_code（所有 type 的 power 變體）
const POWER_PARAM_SET = new Set([
  'power_total',
  'ma_p_sum', 'mb_p_sum',
  ...Array.from({ length: 12 }, (_, i) => `ba${i + 1}_p`),
  ...Array.from({ length: 12 }, (_, i) => `bb${i + 1}_p`),
  'ba1_3_p_sum', 'ba4_6_p_sum', 'ba7_9_p_sum', 'ba10_12_p_sum',
  'bb1_3_p_sum', 'bb4_6_p_sum', 'bb7_9_p_sum', 'bb10_12_p_sum',
]);

// 需量 (Demand P) 相關 parameter_code（老王 2026-06-04「完成需量顯示」；
// backend ECSU mapping M-P12-063 Phase C 已含 map_circuit_to_demand_param）
const DEMAND_PARAM_SET = new Set([
  'demand_p_total', 'demand_p_sum', 'ma_p_dm', 'mb_p_dm',
]);

export default function Trends() {
  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs().subtract(24, 'hour'), dayjs()]);
  const [granularity, setGranularity] = useState<Granularity>('15min');
  const [selectedEcsuId, setSelectedEcsuId] = useState<number | undefined>();
  const [queriedRange, setQueriedRange] = useState<[Dayjs, Dayjs] | null>(null);

  // M-PM-253 §二: ECSU list + sortedEcsuOptions（label: KW-XX · 區域 · 名稱）
  const { data: ecsuListData } = useEcsuList();
  const sortedEcsus = useMemo(() => {
    if (!ecsuListData) return [];
    type Node = (typeof ecsuListData)[number] & { children?: Node[] };
    const tree = buildEcsuTree(ecsuListData) as Node[];
    const flat: typeof ecsuListData = [];
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

  const ecsuSelectOptions = useMemo(
    () =>
      sortedEcsus.map((e) => ({
        value: e.ecsu_id,
        label: `${e.ecsu_code} · ${e.region ?? '—'} · ${e.ecsu_name}`,
      })),
    [sortedEcsus],
  );

  useEffect(() => {
    if (sortedEcsus.length > 0 && selectedEcsuId == null) {
      setSelectedEcsuId(sortedEcsus[0].ecsu_id);
    }
  }, [sortedEcsus, selectedEcsuId]);

  // fetch（ecsu_id 路徑；backend force group_by=ecsu + mapping layer per-binding）
  const energyFilter = useMemo(() => {
    if (!selectedEcsuId || !queriedRange) return null;
    return {
      granularity,
      parameter_codes: ECSU_PARAM_SUPERSET,
      ecsu_id: selectedEcsuId,
      from_ts: queriedRange[0].toISOString(),
      to_ts: queriedRange[1].toISOString(),
    };
  }, [selectedEcsuId, queriedRange, granularity]);
  const { data: energyData, isLoading: energyLoading } = useEnergyReport(energyFilter);

  // chart data prep — power_total trend（聚合 ECSU 所有 power 變體 SUM 後對齊 ts）
  const powerChartData = useMemo(() => {
    if (!energyData?.points?.length) return [] as { ts: string; power: number | null }[];
    const map = new Map<string, number>();
    energyData.points.forEach((p) => {
      if (POWER_PARAM_SET.has(p.parameter_code)) {
        const v = p.avg_value ?? p.last_value ?? null;
        if (v == null) return;
        map.set(p.ts, (map.get(p.ts) ?? 0) + v);
      }
    });
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([ts, v]) => ({
        ts: dayjs(ts).format(granularity === '1day' ? 'MM-DD' : 'MM-DD HH:mm'),
        power: v,
      }));
  }, [energyData, granularity]);

  // 需量趨勢資料（老王 2026-06-04「完成需量顯示」；聚合 ECSU 所有 demand 變體）
  const demandChartData = useMemo(() => {
    if (!energyData?.points?.length) return [] as { ts: string; demand: number | null }[];
    const map = new Map<string, number>();
    energyData.points.forEach((p) => {
      if (DEMAND_PARAM_SET.has(p.parameter_code)) {
        const v = p.avg_value ?? p.last_value ?? null;
        if (v == null) return;
        map.set(p.ts, (map.get(p.ts) ?? 0) + v);
      }
    });
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([ts, v]) => ({
        ts: dayjs(ts).format(granularity === '1day' ? 'MM-DD' : 'MM-DD HH:mm'),
        demand: v,
      }));
  }, [energyData, granularity]);

  const granularityOptions = useMemo(
    () => [
      { value: '5min', label: '5min' }, { value: '15min', label: '15min' },
      { value: '1hr', label: '1hr' }, { value: '1day', label: '1day' },
    ],
    [],
  );

  const selectedEcsu = sortedEcsus.find((e) => e.ecsu_id === selectedEcsuId);

  // ── 匯出 jpg / PDF（老王 2026-07-09：不限權限誰都可下載；前台 iframe 同步生效）──
  // 純前端截圖（html2canvas），不打 API；套件動態載入（點按鈕才抓 chunk，主 bundle 不變胖）
  const exportRef = useRef<HTMLDivElement>(null);
  const [exporting, setExporting] = useState<false | 'jpg' | 'pdf'>(false);
  const hasChart = powerChartData.length > 0 || demandChartData.length > 0;

  const exportChart = async (fmt: 'jpg' | 'pdf') => {
    if (!exportRef.current) return;
    setExporting(fmt);
    try {
      const html2canvas = (await import('html2canvas')).default;
      const canvas = await html2canvas(exportRef.current, {
        scale: 2, backgroundColor: '#ffffff', useCORS: true,
      });
      const fname = `趨勢圖_${selectedEcsu?.ecsu_code ?? 'ECSU'}_${dayjs().format('YYYYMMDD_HHmm')}`;
      if (fmt === 'jpg') {
        const a = document.createElement('a');
        a.href = canvas.toDataURL('image/jpeg', 0.92);
        a.download = `${fname}.jpg`;
        a.click();
      } else {
        const { jsPDF } = await import('jspdf');
        const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
        const pw = pdf.internal.pageSize.getWidth();
        const ph = pdf.internal.pageSize.getHeight();
        // 等比縮放置中塞入 A4 橫式
        const ratio = Math.min(pw / canvas.width, ph / canvas.height);
        const w = canvas.width * ratio;
        const h = canvas.height * ratio;
        pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', (pw - w) / 2, (ph - h) / 2, w, h);
        pdf.save(`${fname}.pdf`);
      }
    } catch (err) {
      alert('匯出失敗：' + (err as Error).message);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div>
      <Title level={3} style={{ marginTop: 0 }}>趨勢圖</Title>
      <Space style={{ marginBottom: 16 }} wrap>
        <RangePicker
          showTime
          value={range}
          onChange={(v) => v && v[0] && v[1] && setRange([v[0], v[1]])}
        />
        {/* M-PM-253 §二: ECSU 下拉取代既有 Edge filter / device / 1PH/3PH / 視角 / circuit 5 selectors */}
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
        <Select
          key={`trends-gran-${granularity}`}
          style={{ width: 120 }}
          value={granularity}
          onChange={setGranularity}
          options={granularityOptions}
        />
        <Button
          type="primary"
          icon={<ReloadOutlined />}
          onClick={() => setQueriedRange([range[0], range[1]])}
          loading={energyLoading}
          disabled={!selectedEcsuId}
        >
          查詢
        </Button>
        {/* 匯出（老王 2026-07-09）：不綁權限，前台 iframe 內誰都可下載 */}
        <Button
          icon={<CameraOutlined />}
          onClick={() => exportChart('jpg')}
          loading={exporting === 'jpg'}
          disabled={!hasChart || energyLoading}
        >
          匯出 jpg
        </Button>
        <Button
          icon={<FilePdfOutlined />}
          onClick={() => exportChart('pdf')}
          loading={exporting === 'pdf'}
          disabled={!hasChart || energyLoading}
        >
          匯出 PDF
        </Button>
      </Space>

      {/* 前台 iframe 嵌入時隱藏後台工程提示（老王 2026-06-12）；後台直接訪問保留 */}
      {!isEmbedded && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="趨勢圖以 ECSU 用電計費單位聚合顯示"
          description={
            <Text type="secondary" style={{ fontSize: 12 }}>
              M-PM-253 §二（老王 5/21 拍板）：選 ECSU → backend 自動聚合該 ECSU 綁定的所有迴路（含 sign 反向潮流計算）。
              {selectedEcsu && (
                <>
                  <br />
                  目前選擇：<Text code>{selectedEcsu.ecsu_code}</Text> · 區域 <Text code>{selectedEcsu.region ?? '—'}</Text> ·{' '}
                  <Text>{selectedEcsu.ecsu_name}</Text>
                </>
              )}
            </Text>
          }
        />
      )}

      {/* 匯出範圍容器：標題列 + 兩張圖一起截（jpg/PDF 內容 = 這個 div）*/}
      <div ref={exportRef} style={{ background: '#fff', padding: 4 }}>
      {queriedRange && selectedEcsu && (
        <Text type="secondary" style={{ display: 'block', fontSize: 12, margin: '0 0 8px 4px' }}>
          {selectedEcsu.ecsu_code} · {selectedEcsu.region ?? '—'} · {selectedEcsu.ecsu_name}
          ｜{queriedRange[0].format('YYYY-MM-DD HH:mm')} ~ {queriedRange[1].format('YYYY-MM-DD HH:mm')}
          ｜粒度 {granularity}
        </Text>
      )}
      <Card title="用電趨勢（總功率 W；ECSU 聚合）" size="small" style={{ marginBottom: 16 }}>
        {energyLoading ? (
          <div style={{ textAlign: 'center', padding: 60 }}><Spin /></div>
        ) : powerChartData.length === 0 ? (
          <Empty description={queriedRange ? '時段內無資料' : '請按「查詢」載入資料'} />
        ) : (
          <ResponsiveContainer width="100%" height={320}>
            <LineChart data={powerChartData} margin={{ top: 8, right: 24, left: 0, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="ts" />
              <YAxis />
              <Tooltip />
              <Legend />
              <Line type="monotone" dataKey="power" name="總功率 (W)" stroke="#1677ff" dot={false} strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </Card>

      {/* 老王 2026-06-12：「P」符號對業主有爭議拿掉；單位 W 依原廠手冊 Ma.P.DM（總有效功率需量）確認 */}
      <Card title="需量趨勢（W；ECSU 聚合）" size="small" style={{ marginTop: 8 }}>
        {energyLoading ? (
          <div style={{ textAlign: 'center', padding: 60 }}><Spin /></div>
        ) : demandChartData.length === 0 ? (
          <Empty description={queriedRange ? '時段內無需量資料' : '請按「查詢」載入資料'} />
        ) : (
          <ResponsiveContainer width="100%" height={320}>
            <LineChart data={demandChartData} margin={{ top: 8, right: 24, left: 0, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="ts" />
              <YAxis />
              <Tooltip />
              <Legend />
              <Line type="monotone" dataKey="demand" name="需量 (W)" stroke="#fa8c16" dot={false} strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </Card>
      </div>
    </div>
  );
}
