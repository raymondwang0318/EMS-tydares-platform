import { useEffect, useState } from 'react';
import { Table, message } from 'antd';
import api from '../services/api';

export default function EdgeStatus() {
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await api.get('/admin/edges');
      setData(res.data.items || res.data || []);
    } catch (e: any) {
      message.error(`載入失敗: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, []);

  const columns = [
    { title: 'Edge ID', dataIndex: 'edge_id', key: 'edge_id' },
    { title: '名稱', dataIndex: 'edge_name', key: 'edge_name' },
    { title: 'Site', dataIndex: 'site_id', key: 'site_id' },
    { title: '建立時間', dataIndex: 'created_at', key: 'created_at' },
  ];

  return (
    <>
      <h2>Edge 狀態</h2>
      <Table columns={columns} dataSource={data} rowKey="edge_id" loading={loading} size="middle" />
    </>
  );
}
