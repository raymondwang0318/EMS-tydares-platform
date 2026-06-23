/**
 * 異常履歷頁（M-PM-306；業主拍板 PM 全推薦）
 *
 * 規格（M-PM-306 §二）：
 *   範圍(d) ems_events 全部運維+應用層+可篩選
 *   時間(a) 24h 預設 + 1h/24h/7d/30d 可調
 *   顯示(d) Table + 可展開 detail row（含 data_json 原始資料）
 *   篩選 (i)+(ii)+(iii)+(vi) = by edge_id + event type + severity + 點 device 跳轉
 *
 * 後端：GET /v1/reports/events?kind&severity&edge_id&device_id&from_ts&to_ts&limit&offset
 *       （v1_reports.py:764 既建，純對接，無需 backend 改動）
 */

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Typography, Card, Table, Tag, Select, Segmented, Space, Button, Alert, Tooltip,
  Popconfirm, message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ReloadOutlined, WarningOutlined, CheckCircleOutlined } from '@ant-design/icons';
import { useMutation, useQuery } from '@tanstack/react-query';
import api from '../services/api';
import { useEdges } from '../hooks/useEdges';
import { humanizeMessage, kindLabel, sevLabel } from '../utils/eventHumanize';

const { Title, Text, Paragraph } = Typography;

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

interface EmsEvent {
  event_id: number;
  ts: string;
  event_kind: string;
  severity: string | null;
  source?: string | null;
  edge_id: string | null;
  device_id: string | null;
  command_id: string | null;
  actor: string | null;
  message: string | null;
  data_json: unknown;
  notify_pananora?: boolean | null;
  resolved_at?: string | null;
}

interface EventsResponse {
  total: number;
  items: EmsEvent[];
}

type TimeRange = '1h' | '24h' | '7d' | '30d';

const TIME_RANGE_MS: Record<TimeRange, number> = {
  '1h': 3600_000,
  '24h': 24 * 3600_000,
  '7d': 7 * 24 * 3600_000,
  '30d': 30 * 24 * 3600_000,
};

const ALL = '__all__';

// severity → Tag color
const sevColor = (s: string | null): string => {
  switch ((s ?? '').toLowerCase()) {
    case 'error':
    case 'critical':
    case 'fatal':
      return 'red';
    case 'warn':
    case 'warning':
      return 'orange';
    case 'info':
      return 'blue';
    default:
      return 'default';
  }
};

const fmtTs = (ts: string): string => {
  try { return new Date(ts).toLocaleString('zh-TW', { hour12: false }); }
  catch { return ts; }
};

// ─────────────────────────────────────────────────────────────
// 主頁
// ─────────────────────────────────────────────────────────────

export default function AnomalyHistory() {
  const navigate = useNavigate();
  const [range, setRange] = useState<TimeRange>('24h');
  const [severity, setSeverity] = useState<string>('error');  // 老王 2026-06-04：預設顯示 error
  const [kind, setKind] = useState<string>(ALL);
  const [edgeId, setEdgeId] = useState<string>(ALL);

  const { data: edgesData } = useEdges();

  // from_ts 依時間範圍計算（client 端算，傳 ISO 給後端）
  const fromTs = useMemo(
    () => new Date(Date.now() - TIME_RANGE_MS[range]).toISOString(),
    [range],
  );

  const params = useMemo(() => {
    const p: Record<string, string | number> = { from_ts: fromTs, limit: 500 };
    if (severity !== ALL) p.severity = severity;
    if (kind !== ALL) p.kind = kind;
    if (edgeId !== ALL) p.edge_id = edgeId;
    return p;
  }, [fromTs, severity, kind, edgeId]);

  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: ['anomaly-events', params],
    queryFn: () => api.get<EventsResponse>('/admin/events', { params }).then((r) => r.data),
    refetchInterval: 30_000,
  });

  // M-PM-313 P4：手動標記事件已解除（POST /v1/admin/events/{id}/resolve）
  const resolveMut = useMutation({
    mutationFn: (eventId: number) => api.post(`/admin/events/${eventId}/resolve`, {}),
    onSuccess: () => { message.success('已標記解除'); refetch(); },
    onError: (e: any) => message.error(`標記失敗：${e?.response?.data?.detail ?? e?.message ?? '未知錯誤'}`),
  });

  const items = data?.items ?? [];

  // 一鍵全解除（老王 2026-06-17）：把當前篩選列表中所有「未解除」事件批次標記解除
  // 範圍＝目前 items（受上方時間/嚴重度/類型/Edge 篩選控制）；純前端迴圈呼叫既有單筆 resolve API（不需後端改）
  const unresolvedCount = useMemo(() => items.filter((e) => !e.resolved_at).length, [items]);
  const resolveAllMut = useMutation({
    mutationFn: async () => {
      const unresolved = items.filter((e) => !e.resolved_at);
      await Promise.all(unresolved.map((e) => api.post(`/admin/events/${e.event_id}/resolve`, {})));
      return unresolved.length;
    },
    onSuccess: (n) => { message.success(`已全部標記解除（${n} 筆）`); refetch(); },
    onError: (e: any) => message.error(`全解除失敗：${e?.response?.data?.detail ?? e?.message ?? '未知錯誤'}`),
  });

  // event_kind 下拉選項：從當前結果集 distinct + 永遠含已選值
  const kindOptions = useMemo(() => {
    const set = new Set<string>();
    items.forEach((e) => e.event_kind && set.add(e.event_kind));
    if (kind !== ALL) set.add(kind);
    return [{ label: '全部類型', value: ALL }, ...[...set].sort().map((k) => ({ label: k, value: k }))];
  }, [items, kind]);

  // severity 下拉：固定常見值（後端單值篩選）
  const sevOptions = [
    { label: '全部嚴重度', value: ALL },
    { label: 'error', value: 'error' },
    { label: 'warn', value: 'warn' },
    { label: 'info', value: 'info' },
  ];

  const edgeOptions = useMemo(() => {
    const edges = (edgesData ?? []).map((e) => e.edge_id).filter(Boolean) as string[];
    return [{ label: '全部 Edge', value: ALL }, ...edges.sort().map((id) => ({ label: id, value: id }))];
  }, [edgesData]);

  const handleDeviceJump = (deviceId: string) => {
    // (vi) 點 device 跳轉：811c→IR 標籤管理頁，其餘→設備管理頁（帶 device_id 供目標頁定位）
    if (deviceId.startsWith('811c_')) navigate('/ir-devices', { state: { focusDeviceId: deviceId } });
    else navigate('/devices', { state: { focusDeviceId: deviceId } });
  };

  const columns: ColumnsType<EmsEvent> = [
    {
      title: '時間', dataIndex: 'ts', width: 170,
      render: (ts: string) => <Text style={{ fontSize: 12 }}>{fmtTs(ts)}</Text>,
      sorter: (a, b) => a.ts.localeCompare(b.ts),
      defaultSortOrder: 'descend',
    },
    {
      title: '嚴重度', dataIndex: 'severity', width: 90,
      render: (s: string | null) => <Tag color={sevColor(s)}>{sevLabel(s)}</Tag>,
    },
    {
      title: '類型', dataIndex: 'event_kind', width: 130,
      render: (k: string) => (
        <Tooltip title={k}><span style={{ fontSize: 12 }}>{kindLabel(k)}</span></Tooltip>
      ),
    },
    {
      title: 'Edge', dataIndex: 'edge_id', width: 130,
      render: (id: string | null) => id ?? '—',
    },
    {
      title: '設備', dataIndex: 'device_id', width: 200,
      render: (id: string | null) =>
        id
          ? <Button type="link" size="small" style={{ padding: 0, fontSize: 12 }} onClick={() => handleDeviceJump(id)}>{id}</Button>
          : '—',
    },
    {
      title: '訊息', dataIndex: 'message', ellipsis: true,
      render: (m: string | null) => (
        <Tooltip title={m || ''}><Text style={{ fontSize: 12 }}>{humanizeMessage(m)}</Text></Tooltip>
      ),
    },
    {
      title: '處理', key: 'resolve', width: 130,
      render: (_, e) =>
        e.resolved_at
          ? <Tag color="green" icon={<CheckCircleOutlined />}>已解除</Tag>
          : (
            <Popconfirm
              title="標記此事件為已解除？"
              okText="確定"
              cancelText="取消"
              onConfirm={() => resolveMut.mutate(e.event_id)}
            >
              <Button type="link" size="small" style={{ padding: 0, fontSize: 12 }}>
                ✅ 標記已解除
              </Button>
            </Popconfirm>
          ),
    },
  ];

  return (
    <div>
      <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 12 }} align="start">
        <div>
          <Title level={3} style={{ margin: 0 }}>
            <WarningOutlined /> 事件履歷
          </Title>
          <Text type="secondary" style={{ fontSize: 12 }}>
            系統運維 + 應用層事件（ems_events）；預設顯示錯誤，可調嚴重度；點設備可跳轉；展開列看原始資料
          </Text>
        </div>
        <Space>
          <Popconfirm
            title={`將當前列表中 ${unresolvedCount} 筆未解除事件全部標記已解除？`}
            description="僅影響目前篩選/顯示的事件"
            okText="全部解除"
            cancelText="取消"
            disabled={unresolvedCount === 0}
            onConfirm={() => resolveAllMut.mutate()}
          >
            <Button danger icon={<CheckCircleOutlined />} disabled={unresolvedCount === 0} loading={resolveAllMut.isPending}>
              一鍵全解除{unresolvedCount > 0 ? `（${unresolvedCount}）` : ''}
            </Button>
          </Popconfirm>
          <Button icon={<ReloadOutlined />} loading={isFetching} onClick={() => refetch()}>重新整理</Button>
        </Space>
      </Space>

      {/* 篩選列 */}
      <Card size="small" style={{ marginBottom: 12 }}>
        <Space wrap size={12}>
          <Space size={4}>
            <Text type="secondary" style={{ fontSize: 12 }}>時間</Text>
            <Segmented
              size="small"
              value={range}
              onChange={(v) => setRange(v as TimeRange)}
              options={[{ label: '1 小時', value: '1h' }, { label: '24 小時', value: '24h' }, { label: '7 天', value: '7d' }, { label: '30 天', value: '30d' }]}
            />
          </Space>
          <Select size="small" style={{ width: 130 }} value={severity} onChange={setSeverity} options={sevOptions} />
          <Select size="small" style={{ width: 180 }} value={kind} onChange={setKind} options={kindOptions} showSearch optionFilterProp="label" />
          <Select size="small" style={{ width: 160 }} value={edgeId} onChange={setEdgeId} options={edgeOptions} showSearch optionFilterProp="label" />
          {data && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              共 {data.total} 筆{data.total > items.length ? `（顯示前 ${items.length}）` : ''}
            </Text>
          )}
        </Space>
      </Card>

      {isError && <Alert type="error" showIcon message="無法載入事件資料，請按重新整理重試" style={{ marginBottom: 12 }} />}

      <Table<EmsEvent>
        rowKey="event_id"
        loading={isLoading}
        dataSource={items}
        columns={columns}
        size="small"
        pagination={{ pageSize: 50, showSizeChanger: true, showTotal: (t) => `${t} 筆` }}
        // 表頭固定（老王 2026-06-10）：表體在視窗高度內捲動，欄名固定最上方
        scroll={{ y: 'calc(100vh - 360px)' }}
        expandable={{
          expandedRowRender: (e) => (
            <div style={{ fontSize: 12, paddingLeft: 8 }}>
              <Space direction="vertical" size={2} style={{ width: '100%' }}>
                <Text type="secondary">event_id: {e.event_id}　actor: {e.actor ?? '—'}　command_id: {e.command_id ?? '—'}</Text>
                <Text type="secondary">來源: {e.source ?? '—'}　通知 Pananora: {e.notify_pananora ? '是' : '否'}　解除: {e.resolved_at ? fmtTs(e.resolved_at) : '未解除'}</Text>
                <Text type="secondary">原始資料 (data_json)：</Text>
                <Paragraph style={{ margin: 0 }}>
                  <pre style={{ margin: 0, fontSize: 11, background: '#fafafa', padding: 8, borderRadius: 4, maxHeight: 280, overflow: 'auto' }}>
                    {e.data_json != null ? JSON.stringify(e.data_json, null, 2) : '（無）'}
                  </pre>
                </Paragraph>
              </Space>
            </div>
          ),
        }}
      />
    </div>
  );
}
