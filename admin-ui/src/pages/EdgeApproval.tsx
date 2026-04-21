import { useEffect, useState } from 'react';
import { Table, Tag, Button, Space, Popconfirm, message } from 'antd';
import { CheckCircleOutlined, StopOutlined, ToolOutlined } from '@ant-design/icons';
import api from '../services/api';

const statusColors: Record<string, string> = {
  pending: 'orange',
  approved: 'green',
  maintenance: 'blue',
  pending_replace: 'purple',
  revoked: 'red',
};

export default function EdgeApproval() {
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await api.get('/admin/edge-credentials');
      setData(res.data.items || res.data || []);
    } catch (e: any) {
      message.error(`載入失敗: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, []);

  const handleAction = async (edgeId: string, action: string) => {
    try {
      await api.post(`/admin/edge-credentials/${edgeId}/${action}`);
      message.success(`${action} 成功`);
      fetchData();
    } catch (e: any) {
      message.error(`操作失敗: ${e.message}`);
    }
  };

  const columns = [
    { title: 'Edge ID', dataIndex: 'edge_id', key: 'edge_id' },
    { title: 'Hostname', dataIndex: 'hostname', key: 'hostname' },
    {
      title: '狀態',
      dataIndex: 'status',
      key: 'status',
      render: (status: string) => <Tag color={statusColors[status] || 'default'}>{status}</Tag>,
    },
    { title: 'Fingerprint', dataIndex: 'fingerprint', key: 'fingerprint',
      render: (fp: string) => fp ? `${fp.substring(0, 16)}...` : '—',
    },
    { title: '最後上線', dataIndex: 'last_seen_at', key: 'last_seen_at' },
    { title: '最後 IP', dataIndex: 'last_seen_ip', key: 'last_seen_ip' },
    { title: '註冊時間', dataIndex: 'registered_at', key: 'registered_at' },
    { title: '核可時間', dataIndex: 'approved_at', key: 'approved_at' },
    {
      title: '操作',
      key: 'actions',
      width: 250,
      render: (_: any, record: any) => (
        <Space>
          {(record.status === 'pending' || record.status === 'pending_replace') && (
            <Popconfirm title="確定核可此 Edge？" onConfirm={() => handleAction(record.edge_id, 'approve')}>
              <Button icon={<CheckCircleOutlined />} type="primary" size="small">核可</Button>
            </Popconfirm>
          )}
          {record.status === 'approved' && (
            <Popconfirm title="標記為維修模式？" onConfirm={() => handleAction(record.edge_id, 'maintenance')}>
              <Button icon={<ToolOutlined />} size="small">維修</Button>
            </Popconfirm>
          )}
          {record.status !== 'revoked' && (
            <Popconfirm title="確定撤銷此 Edge？" onConfirm={() => handleAction(record.edge_id, 'revoke')}>
              <Button icon={<StopOutlined />} danger size="small">撤銷</Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  return (
    <>
      <h2>Edge 核可管理 (ADR-021)</h2>
      <Table columns={columns} dataSource={data} rowKey="edge_id" loading={loading} size="middle" />
    </>
  );
}
