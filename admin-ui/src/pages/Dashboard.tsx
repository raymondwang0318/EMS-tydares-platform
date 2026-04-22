import { useEffect, useState } from 'react';
import { Card, Col, Row, Statistic, Spin, Alert } from 'antd';
import {
  ClusterOutlined,
  ThunderboltOutlined,
  NodeIndexOutlined,
  BellOutlined,
} from '@ant-design/icons';
import api from '../services/api';

/**
 * V2-final 系統總覽
 * - 使用 ADR-026 的 /v1/admin/* + /v1/reports/events
 * - 舊版依賴的 /admin/hubs、/reports/dashboard-stats 於 Oracle 下線後棄用
 */
export default function Dashboard() {
  const [stats, setStats] = useState({ edges: 0, devices: 0, deviceModels: 0, events24h: 0 });
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    const now = new Date();
    const from = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
    Promise.all([
      api.get('/admin/edges').then((r) => (Array.isArray(r.data) ? r.data : r.data?.items ?? []).length).catch(() => 0),
      api.get('/admin/devices').then((r) => (Array.isArray(r.data) ? r.data : r.data?.items ?? []).length).catch(() => 0),
      api.get('/admin/device-models').then((r) => (Array.isArray(r.data) ? r.data : r.data?.items ?? []).length).catch(() => 0),
      api.get('/reports/events', { params: { from_ts: from, limit: 1000 } })
        .then((r) => (Array.isArray(r.data) ? r.data : r.data?.items ?? []).length)
        .catch(() => 0),
    ])
      .then(([edges, devices, deviceModels, events24h]) => {
        setStats({ edges, devices, deviceModels, events24h });
      })
      .catch((e) => setErrorMsg(e.message ?? '載入失敗'))
      .finally(() => setLoading(false));
  }, []);

  return (
    <Spin spinning={loading}>
      <h2 style={{ marginTop: 0 }}>系統總覽</h2>
      {errorMsg && (
        <Alert type="warning" showIcon message={`部分資料載入失敗：${errorMsg}`} style={{ marginBottom: 16 }} />
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
