/**
 * 區間用電比較（M-PM-318；老王 2026-06-10「全部 PM 推薦」5 條 spec）
 *
 * - 3 快速期間：月對月 YoY（上個完整月 vs 去年同月）/ 季度比較（當季 vs 上季）/ 自訂
 * - ECSU 多選 dropdown + 全選 / 清空
 * - Table（ECSU × 期間A × 期間B × Δ kWh × Δ%）+ 總計列 + recharts 雙柱 Bar chart
 * - Excel + CSV 匯出（useReportExport 同 lib）
 *
 * 資料：對每選中 ECSU × 2 期間呼叫既建 GET /v1/reports/energy
 *   ?granularity=1day&ecsu_id=N（backend 自動 force group_by=ecsu + binding mapped params，
 *   M-P12-063 Phase C 路徑——正確性已被既建報表驗證）→ sum points[].energy_delta
 *   （runtime 實測：energy_delta 僅 energy 類 param 非 null，其餘 param 為 null → 直接全 sum 安全）
 * 併發：chunk 8 並行 + 進度顯示；僅查有勾選的 ECSU。
 */
import { useMemo, useState } from 'react';
import {
  Alert, Button, Card, Col, DatePicker, Empty, Row, Select, Space, Spin,
  Statistic, Table, Tag, Typography, message,
} from 'antd';
import { SearchOutlined, FileExcelOutlined, FileTextOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { Dayjs } from 'dayjs';
import {
  Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import api from '../services/api';
import { useEcsuList, type EcsuRow } from '../hooks/useEcsu';
import { useReportExport, type ExportColumn } from '../hooks/useReportExport';

const { RangePicker } = DatePicker;
const { Text } = Typography;

interface CompareRow {
  ecsu_id: number;
  ecsu_code: string;
  ecsu_name: string;
  region: string | null;
  kwhA: number | null; // null = 該期間查詢失敗 / 無資料
  kwhB: number | null;
  delta: number | null;
  deltaPct: number | null; // 分母 0 → null（顯示 —）
}

type RangeVal = [Dayjs, Dayjs];

const KW_REGEX = /^KW-(\d+)$/;
function ecsuSort(a: EcsuRow, b: EcsuRow): number {
  const am = a.ecsu_code.match(KW_REGEX);
  const bm = b.ecsu_code.match(KW_REGEX);
  if (am && bm) return parseInt(am[1], 10) - parseInt(bm[1], 10);
  if (am) return -1;
  if (bm) return 1;
  return a.ecsu_code.localeCompare(b.ecsu_code);
}

/** 取單 ECSU 單期間 kWh（sum energy_delta）；失敗回 null */
async function fetchPeriodKwh(ecsuId: number, range: RangeVal): Promise<number | null> {
  try {
    const params = new URLSearchParams();
    params.append('granularity', '1day');
    params.append('ecsu_id', String(ecsuId));
    params.append('from_ts', range[0].startOf('day').toISOString());
    params.append('to_ts', range[1].endOf('day').toISOString());
    const { data } = await api.get(`/reports/energy?${params.toString()}`);
    const points: Array<{ energy_delta: number | null }> = data?.points ?? [];
    let sum = 0;
    let has = false;
    for (const p of points) {
      if (p.energy_delta != null) {
        sum += p.energy_delta;
        has = true;
      }
    }
    return has ? sum : null;
  } catch {
    return null;
  }
}

export default function RangeCompare() {
  const { data: ecsuRows } = useEcsuList();
  const { exportToExcel, exportToCsv, isExporting } = useReportExport();

  const ecsuOptions = useMemo(() => {
    const enabled = (ecsuRows ?? []).filter((r) => r.enabled).sort(ecsuSort);
    return enabled.map((r) => ({
      value: r.ecsu_id,
      label: `${r.ecsu_code} · ${r.region ?? '—'} · ${r.ecsu_name}`,
    }));
  }, [ecsuRows]);

  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  // 預設：月對月 YoY（上個完整月 vs 去年同月）
  const lastMonth = dayjs().subtract(1, 'month');
  const [periodA, setPeriodA] = useState<RangeVal>([
    lastMonth.subtract(1, 'year').startOf('month'), lastMonth.subtract(1, 'year').endOf('month'),
  ]);
  const [periodB, setPeriodB] = useState<RangeVal>([
    lastMonth.startOf('month'), lastMonth.endOf('month'),
  ]);

  const [rows, setRows] = useState<CompareRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<[number, number] | null>(null);
  const [queried, setQueried] = useState(false);

  // 快速期間按鈕
  const applyYoY = () => {
    const lm = dayjs().subtract(1, 'month');
    setPeriodA([lm.subtract(1, 'year').startOf('month'), lm.subtract(1, 'year').endOf('month')]);
    setPeriodB([lm.startOf('month'), lm.endOf('month')]);
  };
  const applyQuarter = () => {
    const qStartMonth = Math.floor(dayjs().month() / 3) * 3; // 0/3/6/9
    const curQ = dayjs().month(qStartMonth).startOf('month');
    const prevQ = curQ.subtract(3, 'month');
    setPeriodA([prevQ, prevQ.add(2, 'month').endOf('month')]);
    setPeriodB([curQ, dayjs()]); // 當季至今
  };

  const runCompare = async () => {
    if (selectedIds.length === 0) {
      message.warning('請先選擇至少一個 ECSU（或按「全選」）');
      return;
    }
    setLoading(true);
    setQueried(true);
    const byId = new Map((ecsuRows ?? []).map((r) => [r.ecsu_id, r]));
    const tasks = selectedIds.map((id) => ({ id, meta: byId.get(id) }));
    const total = tasks.length * 2;
    let done = 0;
    setProgress([0, total]);
    const out: CompareRow[] = [];
    const CHUNK = 8;
    for (let i = 0; i < tasks.length; i += CHUNK) {
      const chunk = tasks.slice(i, i + CHUNK);
      const results = await Promise.all(
        chunk.map(async ({ id, meta }) => {
          const kwhA = await fetchPeriodKwh(id, periodA);
          done += 1; setProgress([done, total]);
          const kwhB = await fetchPeriodKwh(id, periodB);
          done += 1; setProgress([done, total]);
          const delta = kwhA != null && kwhB != null ? kwhB - kwhA : null;
          const deltaPct = kwhA != null && kwhB != null && Math.abs(kwhA) > 0.0001
            ? ((kwhB - kwhA) / Math.abs(kwhA)) * 100 : null;
          return {
            ecsu_id: id,
            ecsu_code: meta?.ecsu_code ?? String(id),
            ecsu_name: meta?.ecsu_name ?? '—',
            region: meta?.region ?? null,
            kwhA, kwhB, delta, deltaPct,
          } as CompareRow;
        }),
      );
      out.push(...results);
    }
    out.sort((a, b) => ecsuSort(
      { ecsu_code: a.ecsu_code } as EcsuRow, { ecsu_code: b.ecsu_code } as EcsuRow));
    setRows(out);
    setLoading(false);
    setProgress(null);
  };

  // 總計
  const totals = useMemo(() => {
    const sumA = rows.reduce((s, r) => s + (r.kwhA ?? 0), 0);
    const sumB = rows.reduce((s, r) => s + (r.kwhB ?? 0), 0);
    const delta = sumB - sumA;
    const pct = Math.abs(sumA) > 0.0001 ? (delta / Math.abs(sumA)) * 100 : null;
    return { sumA, sumB, delta, pct };
  }, [rows]);

  const fmtKwh = (v: number | null) => (v == null ? '—' : v.toFixed(1));
  const fmtPct = (v: number | null) =>
    v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
  const deltaColor = (v: number | null) =>
    v == null ? undefined : v > 0 ? '#cf1322' : v < 0 ? '#3f8600' : undefined; // 用電增=紅 減=綠

  const labelA = `${periodA[0].format('YYYY/MM/DD')}–${periodA[1].format('YYYY/MM/DD')}`;
  const labelB = `${periodB[0].format('YYYY/MM/DD')}–${periodB[1].format('YYYY/MM/DD')}`;

  const columns: ColumnsType<CompareRow> = [
    { title: '代碼', dataIndex: 'ecsu_code', key: 'code', width: 100 },
    { title: '區域', dataIndex: 'region', key: 'region', width: 110, render: (v) => v || <Text type="secondary">—</Text> },
    { title: '名稱', dataIndex: 'ecsu_name', key: 'name', ellipsis: true },
    { title: `期間A (kWh)`, key: 'kwhA', width: 130, align: 'right', render: (_, r) => <Text style={{ fontFamily: 'monospace' }}>{fmtKwh(r.kwhA)}</Text> },
    { title: `期間B (kWh)`, key: 'kwhB', width: 130, align: 'right', render: (_, r) => <Text style={{ fontFamily: 'monospace' }}>{fmtKwh(r.kwhB)}</Text> },
    { title: 'Δ kWh', key: 'delta', width: 120, align: 'right', render: (_, r) => <Text style={{ fontFamily: 'monospace', color: deltaColor(r.delta) }}>{r.delta == null ? '—' : `${r.delta > 0 ? '+' : ''}${r.delta.toFixed(1)}`}</Text> },
    { title: 'Δ %', key: 'pct', width: 100, align: 'right', render: (_, r) => <Text style={{ fontFamily: 'monospace', color: deltaColor(r.delta) }}>{fmtPct(r.deltaPct)}</Text> },
  ];

  const chartData = useMemo(
    () => rows.map((r) => ({ name: r.ecsu_code, 期間A: r.kwhA ?? 0, 期間B: r.kwhB ?? 0 })),
    [rows],
  );

  const exportColumns: ExportColumn<CompareRow>[] = [
    { key: 'ecsu_code', header: '代碼' },
    { key: 'region', header: '區域', render: (r) => r.region ?? '' },
    { key: 'ecsu_name', header: '名稱' },
    { key: 'kwhA', header: `期間A ${labelA} (kWh)`, render: (r) => (r.kwhA == null ? '—' : r.kwhA.toFixed(1)) },
    { key: 'kwhB', header: `期間B ${labelB} (kWh)`, render: (r) => (r.kwhB == null ? '—' : r.kwhB.toFixed(1)) },
    { key: 'delta', header: '差異 (kWh)', render: (r) => (r.delta == null ? '—' : r.delta.toFixed(1)) },
    { key: 'deltaPct', header: '差異 (%)', render: (r) => (r.deltaPct == null ? '—' : r.deltaPct.toFixed(1)) },
  ];
  const exportName = (ext: string) =>
    `Tydares_區間用電比較_${dayjs().format('YYYYMMDD_HH')}.${ext}`;

  return (
    <div>
      {/* Filter bar */}
      <Card size="small" style={{ marginBottom: 16 }}>
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <Space wrap>
            <Text strong>快速期間：</Text>
            <Button size="small" onClick={applyYoY}>月對月 YoY</Button>
            <Button size="small" onClick={applyQuarter}>季度比較</Button>
            <Text type="secondary" style={{ fontSize: 12 }}>（或直接於下方自訂兩個期間）</Text>
          </Space>
          <Space wrap>
            <Text>期間 A（基準）：</Text>
            <RangePicker value={periodA} onChange={(v) => v && v[0] && v[1] && setPeriodA([v[0], v[1]])} allowClear={false} />
            <Text>期間 B（比較）：</Text>
            <RangePicker value={periodB} onChange={(v) => v && v[0] && v[1] && setPeriodB([v[0], v[1]])} allowClear={false} />
          </Space>
          <Space wrap style={{ width: '100%' }}>
            <Text>ECSU：</Text>
            <Select
              mode="multiple"
              style={{ minWidth: 420, maxWidth: 720 }}
              placeholder="選擇 ECSU（可多選）"
              options={ecsuOptions}
              value={selectedIds}
              onChange={setSelectedIds}
              maxTagCount={4}
              filterOption={(input, opt) =>
                String(opt?.label ?? '').toLowerCase().includes(input.toLowerCase())}
            />
            <Button size="small" onClick={() => setSelectedIds(ecsuOptions.map((o) => o.value))}>全選</Button>
            <Button size="small" onClick={() => setSelectedIds([])}>清空</Button>
            <Button type="primary" icon={<SearchOutlined />} onClick={runCompare} loading={loading}>
              查詢比較
            </Button>
            {progress && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                查詢中 {progress[0]}/{progress[1]}…
              </Text>
            )}
          </Space>
        </Space>
      </Card>

      {!queried && (
        <Alert type="info" showIcon style={{ marginBottom: 16 }}
          message="選擇期間與 ECSU 後按「查詢比較」；期間天數不同時請自行留意比較基準" />
      )}

      {queried && !loading && rows.length === 0 && <Empty description="無資料" />}

      {rows.length > 0 && (
        <>
          {/* 總計 KPI */}
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col span={6}><Card size="small"><Statistic title={`期間A 總計 (${labelA})`} value={totals.sumA} precision={1} suffix="kWh" /></Card></Col>
            <Col span={6}><Card size="small"><Statistic title={`期間B 總計 (${labelB})`} value={totals.sumB} precision={1} suffix="kWh" /></Card></Col>
            <Col span={6}><Card size="small"><Statistic title="總差異" value={totals.delta} precision={1} suffix="kWh" valueStyle={{ color: deltaColor(totals.delta) }} /></Card></Col>
            <Col span={6}><Card size="small"><Statistic title="總差異 %" value={totals.pct == null ? '—' : totals.pct.toFixed(1)} suffix={totals.pct == null ? '' : '%'} valueStyle={{ color: deltaColor(totals.delta) }} /></Card></Col>
          </Row>

          {/* Bar chart 雙柱 */}
          <Card size="small" style={{ marginBottom: 16 }} title={<Space>雙期間對比 <Tag>期間A：{labelA}</Tag><Tag color="blue">期間B：{labelB}</Tag></Space>}>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="name" />
                <YAxis unit=" kWh" width={90} />
                <Tooltip />
                <Legend />
                <Bar dataKey="期間A" fill="#8c8c8c" />
                <Bar dataKey="期間B" fill="#1677ff" />
              </BarChart>
            </ResponsiveContainer>
          </Card>

          {/* Table + 匯出 */}
          <Card
            size="small"
            title="比較明細"
            extra={
              <Space>
                <Button size="small" icon={<FileExcelOutlined />} loading={isExporting}
                  onClick={() => { exportToExcel({ rows, columns: exportColumns, filename: exportName('xlsx'), sheetName: '區間用電比較' }); message.success('已匯出 Excel'); }}>
                  Excel
                </Button>
                <Button size="small" icon={<FileTextOutlined />} loading={isExporting}
                  onClick={() => { exportToCsv({ rows, columns: exportColumns, filename: exportName('csv'), sheetName: '區間用電比較' }); message.success('已匯出 CSV'); }}>
                  CSV
                </Button>
              </Space>
            }
          >
            {loading ? <Spin /> : (
              <Table<CompareRow>
                rowKey="ecsu_id"
                columns={columns}
                dataSource={rows}
                size="small"
                pagination={false}
                scroll={{ y: 'calc(100vh - 420px)' }}
                summary={() => (
                  <Table.Summary fixed>
                    <Table.Summary.Row>
                      <Table.Summary.Cell index={0} colSpan={3}><Text strong>總計（{rows.length} 個 ECSU）</Text></Table.Summary.Cell>
                      <Table.Summary.Cell index={1} align="right"><Text strong style={{ fontFamily: 'monospace' }}>{totals.sumA.toFixed(1)}</Text></Table.Summary.Cell>
                      <Table.Summary.Cell index={2} align="right"><Text strong style={{ fontFamily: 'monospace' }}>{totals.sumB.toFixed(1)}</Text></Table.Summary.Cell>
                      <Table.Summary.Cell index={3} align="right"><Text strong style={{ fontFamily: 'monospace', color: deltaColor(totals.delta) }}>{`${totals.delta > 0 ? '+' : ''}${totals.delta.toFixed(1)}`}</Text></Table.Summary.Cell>
                      <Table.Summary.Cell index={4} align="right"><Text strong style={{ fontFamily: 'monospace', color: deltaColor(totals.delta) }}>{totals.pct == null ? '—' : `${totals.pct > 0 ? '+' : ''}${totals.pct.toFixed(1)}%`}</Text></Table.Summary.Cell>
                    </Table.Summary.Row>
                  </Table.Summary>
                )}
              />
            )}
          </Card>
        </>
      )}
    </div>
  );
}
