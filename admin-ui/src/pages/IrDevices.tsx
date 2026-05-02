/**
 * IR (811C) 標籤管理頁 — 全站 IR 設備唯讀總覽 + 編輯 display_name。
 *
 * T-S11C-001 AC 5（M-PM-074 P11 scope）：
 * - 不新增 / 不刪除（811C 不註冊 ems_device；新增由 trx_reading 派生）
 * - 編輯欄位只有 display_name
 * - 未命名 → 橘色警告「請填寫名稱代號以利辨識」
 * - placeholder 範例對齊老王 chat：「農技大樓 1F 機房門口 / 變電室 A 區 / 配電盤 #3 主匯流排」
 *
 * 端點對接（M-PM-084 §1 簽核 P12 commit `0be99e0` + `90e82c2`）：
 *   GET  /v1/admin/ir-devices
 *   PUT  /v1/admin/ir-devices/{device_id}/label
 */
import { useState } from 'react';
import { Alert, Button, Form, Input, Modal, Table, Tag, Typography, message } from 'antd';
import { EditOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import {
  useIrDevices,
  useUpsertIrLabel,
  isIrUnnamed,
  type IrDevice,
} from '../hooks/useIrDevices';

const { Title, Text } = Typography;

export default function IrDevices() {
  const { data, isLoading, error } = useIrDevices();
  const upsert = useUpsertIrLabel();
  const [editing, setEditing] = useState<IrDevice | null>(null);
  const [form] = Form.useForm<{ display_name: string }>();

  const handleEdit = (rec: IrDevice) => {
    setEditing(rec);
    form.setFieldsValue({ display_name: rec.display_name ?? '' });
  };

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      if (!editing) return;
      await upsert.mutateAsync({
        device_id: editing.device_id,
        display_name: values.display_name.trim(),
      });
      message.success('已更新名稱代號');
      setEditing(null);
    } catch (e: any) {
      if (e?.errorFields) return; // form validation error；UI 已顯示
      message.error(`更新失敗：${e?.response?.data?.detail ?? e?.message ?? '未知錯誤'}`);
    }
  };

  const columns: ColumnsType<IrDevice> = [
    {
      title: '名稱代號',
      dataIndex: 'display_name',
      key: 'display_name',
      render: (_v, rec) =>
        isIrUnnamed(rec) ? (
          <Tag color="orange">⚠ 未命名 — 請填寫名稱代號以利辨識</Tag>
        ) : (
          <Text strong>{rec.display_name}</Text>
        ),
    },
    {
      title: 'MAC（系統識別用）',
      dataIndex: 'device_id',
      key: 'device_id',
      width: 280,
      render: (v: string) => (
        <Text type="secondary" style={{ fontSize: 12, fontFamily: 'monospace' }}>
          {v}
        </Text>
      ),
    },
    {
      title: '最後上報',
      dataIndex: 'last_seen',
      key: 'last_seen',
      width: 180,
      render: (v: string | null) =>
        v ? dayjs(v).format('YYYY-MM-DD HH:mm:ss') : <Text type="secondary">—</Text>,
    },
    {
      title: '操作',
      key: 'actions',
      width: 90,
      render: (_, rec) => (
        <Button
          icon={<EditOutlined />}
          size="small"
          onClick={() => handleEdit(rec)}
          aria-label="編輯名稱代號"
        />
      ),
    },
  ];

  return (
    <div>
      <Title level={3} style={{ marginTop: 0 }}>
        IR 標籤管理
      </Title>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="811C 熱像 IR 設備清單（從 trx_reading 派生 — 不註冊主設備表）"
        description="填寫名稱代號（display_name）即納入健康監控；未命名設備不觸發離線告警（ADR-028 DR-028-02）。MAC 僅作系統識別用，不出現在報表前台。"
      />
      {error && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message="載入 IR 設備清單失敗"
          description={String((error as any)?.message ?? error)}
        />
      )}
      <Table<IrDevice>
        rowKey="device_id"
        columns={columns}
        dataSource={data ?? []}
        loading={isLoading}
        size="middle"
        pagination={{ pageSize: 20 }}
        locale={{ emptyText: 'trx_reading 尚無 811c_* 資料；待 Edge 採集累積或老王連網更多 IR 設備' }}
      />
      <Modal
        title={`編輯名稱代號：${editing?.device_id ?? ''}`}
        open={!!editing}
        onOk={handleSave}
        onCancel={() => setEditing(null)}
        okText="儲存"
        cancelText="取消"
        confirmLoading={upsert.isPending}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item
            name="display_name"
            label="名稱代號"
            rules={[
              { required: true, message: '請輸入名稱代號' },
              { max: 100, message: '不超過 100 字' },
            ]}
            extra="範例：農技大樓 1F 機房門口 / 變電室 A 區 / 配電盤 #3 主匯流排"
          >
            <Input placeholder="例：農技大樓 1F 機房門口" autoFocus />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
