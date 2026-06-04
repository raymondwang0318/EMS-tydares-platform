import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, Col, Row, Space, Statistic, Spin, Alert, Typography, List, Tag, Empty } from 'antd';
import {
  ClusterOutlined,
  ThunderboltOutlined,
  NodeIndexOutlined,
  BellOutlined,
  ReloadOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import api from '../services/api';

const { Title, Text } = Typography;

// M-PM-306：Dashboard 首頁「最近異常」widget
interface EmsEvent {
  event_id: number;
  ts: string;
  event_kind: string;
  severity: string | null;
  edge_id: string | null;
  message: string | null;
}

const sevColor = (s: string | null): string => {
  switch ((s ?? '').toLowerCase()) {
    case 'error': case 'critical': case 'fatal': return 'red';
    case 'warn': case 'warning': return 'orange';
    case 'info': return 'blue';
    default: return 'default';
  }
};
const fmtTs = (ts: string): string => {
  try { return new Date(ts).toLocaleString('zh-TW', { hour12: false }); } catch { return ts; }
};

/**
 * V2-final 系統總覽
 * - 使用 ADR-026 的 /v1/admin/* + /v1/reports/events
 * - 舊版依賴的 /admin/hubs、/reports/dashboard-stats 於 Oracle 下線後棄用
 *
 * M-PM-136 修：
 *   - 老王 2026-05-06 19:15 chat：「點選後還要再按一次重新整理 設備數量才會更新」
 *   - 抽 fetchStats useCallback；mount + 顯式「重新整理」共用同一 fetch 流程
 *   - 加 console.error 4 endpoint 各別失敗 trace（F12 採證 root cause）
 *   - 加 lastUpdate 顯示「最後更新時間」（user 信號透明）
 *   - 加「重新整理」按鈕（顯式手動 refetch；與 Edges 頁 reload pattern 對齊）
 */
export default function Dashboard() {
  const navigate = useNavigate();
  const [stats, setStats] = useState({ edges: 0, devices: 0, deviceModels: 0, events24h: 0 });
  const [recentEvents, setRecentEvents] = useState<EmsEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [failedEndpoints, setFailedEndpoints] = useState<string[]>([]);

  const fetchStats = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    const failures: string[] = [];
    const now = new Date();
    const from = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();

    const fetchOne = (label: string, p: Promise<number>): Promise<number> =>
      p.catch((err) => {
        const status = err?.response?.status;
        const detail = err?.response?.data?.detail ?? err?.message ?? 'unknown';
        console.error(`[Dashboard] ${label} fetch failed`, { status, detail, err });
        failures.push(`${label}${status ? ` (HTTP ${status})` : ''}`);
        return 0;
      });

    try {
      const [edges, devices, deviceModels, events24h] = await Promise.all([
        fetchOne(
          '/admin/edges',
          api.get('/admin/edges').then((r) => (Array.isArray(r.data) ? r.data : r.data?.items ?? []).length),
        ),
        fetchOne(
          '/admin/devices',
          api.get('/admin/devices').then((r) => (Array.isArray(r.data) ? r.data : r.data?.items ?? []).length),
        ),
        fetchOne(
          '/admin/device-models',
          api.get('/admin/device-models').then((r) => (Array.isArray(r.data) ? r.data : r.data?.items ?? []).length),
        ),
        fetchOne(
          '/reports/events',
          api
            .get('/reports/events', { params: { from_ts: from, limit: 1000 } })
            .then((r) => {
              const its: EmsEvent[] = Array.isArray(r.data) ? r.data : r.data?.items ?? [];
              // M-PM-306：最近異常 widget — 取 warn/error 前 6 筆（已 ts DESC）
              const anomalies = its.filter((e) => ['error', 'warn', 'warning', 'critical', 'fatal'].includes((e.severity ?? '').toLowerCase()));
              setRecentEvents((anomalies.length ? anomalies : its).slice(0, 6));
              return its.length;
            }),
        ),
      ]);
      setStats({ edges, devices, deviceModels, events24h });
      setFailedEndpoints(failures);
      setLastUpdate(new Date());
      console.log('[Dashboard] fetchStats complete', {
        edges, devices, deviceModels, events24h, failedEndpoints: failures,
      });
    } catch (e: any) {
      console.error('[Dashboard] fetchStats unexpected error', e);
      setErrorMsg(e?.message ?? '載入失敗');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  return (
    <Spin spinning={loading}>
      <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 16 }} align="start">
        <div>
          <Title level={3} style={{ margin: 0 }}>系統總覽</Title>
          {lastUpdate && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              最後更新 {lastUpdate.toLocaleTimeString('zh-TW')}
            </Text>
          )}
        </div>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={fetchStats}>
          重新整理
        </Button>
      </Space>

      {errorMsg && (
        <Alert type="warning" showIcon message={`部分資料載入失敗：${errorMsg}`} style={{ marginBottom: 16 }} />
      )}
      {failedEndpoints.length > 0 && !errorMsg && (
        // M-PM-136 採證留 trace：個別 endpoint 失敗清單；F12 console 看 [Dashboard] fetch failed 詳細 status/detail
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={`${failedEndpoints.length} / 4 endpoint 載入失敗`}
          description={`${failedEndpoints.join(' / ')}（F12 Console 看 [Dashboard] 詳情；點「重新整理」可重試）`}
        />
      )}
      <Row gutter={16}>
        <Col xs={12} md={6}>
          <Card>
            <Statistic title="Edge 節點" value={stats.edges} prefix={<NodeIndexOutlined />} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card>
            <Statistic title="Modbus 設備" value={stats.devices} prefix={<ThunderboltOutlined />} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card>
            <Statistic title="設備型號" value={stats.deviceModels} prefix={<ClusterOutlined />} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card hoverable onClick={() => navigate('/events')} style={{ cursor: 'pointer' }}>
            <Statistic title="24h 事件" value={stats.events24h} prefix={<BellOutlined />} />
          </Card>
        </Col>
      </Row>

      {/* M-PM-306：最近異常 widget */}
      <Row style={{ marginTop: 16 }}>
        <Col span={24}>
          <Card
            size="small"
            title={<Space size={6}><WarningOutlined style={{ color: '#fa8c16' }} /><Text strong>最近異常</Text></Space>}
            extra={<Button type="link" size="small" onClick={() => navigate('/events')}>查看全部 →</Button>}
          >
            {recentEvents.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="近 24 小時無異常事件" />
            ) : (
              <List
                size="small"
                dataSource={recentEvents}
                renderItem={(e) => (
                  <List.Item style={{ cursor: 'pointer' }} onClick={() => navigate('/events')}>
                    <Space size={8} wrap style={{ width: '100%' }}>
                      <Tag color={sevColor(e.severity)} style={{ marginRight: 0 }}>{e.severity ?? '—'}</Tag>
                      <Text style={{ fontSize: 12, color: '#888', minWidth: 150 }}>{fmtTs(e.ts)}</Text>
                      <Text code style={{ fontSize: 12 }}>{e.event_kind}</Text>
                      {e.edge_id && <Text type="secondary" style={{ fontSize: 12 }}>{e.edge_id}</Text>}
                      <Text style={{ fontSize: 12 }}>{e.message ?? ''}</Text>
                    </Space>
                  </List.Item>
                )}
              />
            )}
          </Card>
        </Col>
      </Row>
    </Spin>
  );
}
