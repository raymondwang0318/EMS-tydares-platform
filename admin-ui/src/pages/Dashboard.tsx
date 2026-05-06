import { useCallback, useEffect, useState } from 'react';
import { Button, Card, Col, Row, Space, Statistic, Spin, Alert, Typography } from 'antd';
import {
  ClusterOutlined,
  ThunderboltOutlined,
  NodeIndexOutlined,
  BellOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import api from '../services/api';

const { Title, Text } = Typography;

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
  const [stats, setStats] = useState({ edges: 0, devices: 0, deviceModels: 0, events24h: 0 });
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
            .then((r) => (Array.isArray(r.data) ? r.data : r.data?.items ?? []).length),
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
          <Card>
            <Statistic title="24h 事件" value={stats.events24h} prefix={<BellOutlined />} />
          </Card>
        </Col>
      </Row>
    </Spin>
  );
}
