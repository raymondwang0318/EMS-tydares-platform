import { useEffect, useState } from 'react';
import { Table, Button, Modal, Form, Input, InputNumber, DatePicker, Select, message, Tag } from 'antd';
import { SwapOutlined } from '@ant-design/icons';
import api from '../services/api';

export default function MeterSwap() {
  const [swaps, setSwaps] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [form] = Form.useForm();

  const fetchSwaps = async () => {
    setLoading(true);
    try {
      const res = await api.get('/admin/meter-swaps');
      setSwaps(Array.isArray(res.data) ? res.data : []);
    } catch (e: any) {
      message.error(`載入失敗: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchSwaps(); }, []);

  const handleSwap = async () => {
    try {
      const values = await form.validateFields();
      await api.post('/admin/meter-swaps', {
        ...values,
        old_removed_at: values.old_removed_at?.toISOString(),
        new_installed_at: values.new_installed_at?.toISOString(),
      });
      message.success('電表替換紀錄已建立');
      setModalOpen(false);
      form.resetFields();
      fetchSwaps();
    } catch (e: any) {
      if (e.errorFields) return;
      message.error(`儲存失敗: ${e.message}`);
    }
  };

  const columns = [
    { title: 'ID', dataIndex: 'swap_id', key: 'swap_id', width: 60 },
    { title: 'ECSU', dataIndex: 'ecsu_id', key: 'ecsu_id', width: 80 },
    {
      title: '舊電表',
      key: 'old',
      render: (_: any, r: any) => (
        <span>
          <Tag color="red">{r.old_device_name || r.old_device_id}</Tag>
          最後讀數: {r.old_final_reading} kWh
        </span>
      ),
    },
    {
      title: '新電表',
      key: 'new',
      render: (_: any, r: any) => (
        <span>
          <Tag color="green">{r.new_device_name || r.new_device_id}</Tag>
          初始讀數: {r.new_initial_reading} kWh
        </span>
      ),
    },
    {
      title: 'Offset',
      dataIndex: 'offset_kwh',
      key: 'offset_kwh',
      width: 120,
      render: (v: number) => <strong>{v} kWh</strong>,
    },
    { title: '替換原因', dataIndex: 'swap_reason', key: 'swap_reason' },
    { title: '操作者', dataIndex: 'operated_by', key: 'operated_by', width: 100 },
    { title: '建立時間', dataIndex: 'created_at', key: 'created_at' },
  ];

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2>電表替換管理</h2>
        <Button type="primary" icon={<SwapOutlined />} onClick={() => setModalOpen(true)}>
          登記替換
        </Button>
      </div>

      <Table columns={columns} dataSource={swaps} rowKey="swap_id" loading={loading} size="middle" />

      <Modal
        title="電表替換登記"
        open={modalOpen}
        onOk={handleSwap}
        onCancel={() => setModalOpen(false)}
        okText="確認替換"
        cancelText="取消"
        width={600}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="ecsu_id" label="ECSU (計費單位 ID)">
            <InputNumber style={{ width: '100%' }} />
          </Form.Item>

          <div style={{ background: '#fff1f0', padding: 16, borderRadius: 8, marginBottom: 16 }}>
            <h4 style={{ color: '#cf1322', margin: '0 0 12px 0' }}>舊電表（拆除）</h4>
            <Form.Item name="old_device_id" label="舊電表代碼" rules={[{ required: true, message: '必填' }]}>
              <Input placeholder="如 CPM12D-001" />
            </Form.Item>
            <Form.Item name="old_device_name" label="舊電表名稱">
              <Input />
            </Form.Item>
            <Form.Item name="old_final_reading" label="最後累計讀數 (kWh)" rules={[{ required: true, message: '必填' }]}>
              <InputNumber style={{ width: '100%' }} precision={2} min={0} />
            </Form.Item>
            <Form.Item name="old_removed_at" label="拆除時間" rules={[{ required: true, message: '必填' }]}>
              <DatePicker showTime style={{ width: '100%' }} />
            </Form.Item>
          </div>

          <div style={{ background: '#f6ffed', padding: 16, borderRadius: 8, marginBottom: 16 }}>
            <h4 style={{ color: '#389e0d', margin: '0 0 12px 0' }}>新電表（安裝）</h4>
            <Form.Item name="new_device_id" label="新電表代碼" rules={[{ required: true, message: '必填' }]}>
              <Input placeholder="如 CPM12D-002" />
            </Form.Item>
            <Form.Item name="new_device_name" label="新電表名稱">
              <Input />
            </Form.Item>
            <Form.Item name="new_initial_reading" label="初始讀數 (kWh)" initialValue={0}>
              <InputNumber style={{ width: '100%' }} precision={2} min={0} />
            </Form.Item>
            <Form.Item name="new_installed_at" label="安裝時間" rules={[{ required: true, message: '必填' }]}>
              <DatePicker showTime style={{ width: '100%' }} />
            </Form.Item>
          </div>

          <Form.Item name="swap_reason" label="替換原因">
            <Select placeholder="選擇原因">
              <Select.Option value="硬體故障">硬體故障</Select.Option>
              <Select.Option value="校驗更換">校驗更換</Select.Option>
              <Select.Option value="升級替換">升級替換</Select.Option>
              <Select.Option value="其他">其他</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item name="operated_by" label="操作者">
            <Input />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
