import { useEffect, useState } from 'react';
import { Card, Col, Row, Statistic, Spin } from 'antd';
import { ClusterOutlined, ThunderboltOutlined, NodeIndexOutlined, DatabaseOutlined } from '@ant-design/icons';
import api from '../services/api';

export default function Dashboard() {
  const [stats, setStats] = useState({ hubs: 0, devices: 0, edges: 0, inbox: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.get('/admin/hubs').then(r => (Array.isArray(r.data) ? r.data : []).length).catch(() => 0),
      api.get('/admin/modbus-devices').then(r => (Array.isArray(r.data) ? r.data : []).length).catch(() => 0),
      api.get('/admin/edges').then(r => (Array.isArray(r.data) ? r.data : []).length).catch(() => 0),
      api.get('/reports/dashboard-stats').then(r => r.data?.today_alerts || 0).catch(() => 0),
    ]).then(([hubs, devices, edges, inbox]) => {
      setStats({ hubs, devices, edges, inbox });
    }).finally(() => setLoading(false));
  }, []);

  return (
    <Spin spinning={loading}>
      <h2>系統總覽</h2>
      <Row gutter={16}>
        <Col span={6}>
          <Card><Statistic title="Edge Gateway" value={stats.hubs} prefix={<ClusterOutlined />} /></Card>
        </Col>
        <Col span={6}>
          <Card><Statistic title="Modbus 設備" value={stats.devices} prefix={<ThunderboltOutlined />} /></Card>
        </Col>
        <Col span={6}>
          <Card><Statistic title="Edge 節點" value={stats.edges} prefix={<NodeIndexOutlined />} /></Card>
        </Col>
        <Col span={6}>
          <Card><Statistic title="今日告警" value={stats.inbox} prefix={<DatabaseOutlined />} /></Card>
        </Col>
      </Row>
    </Spin>
  );
}
