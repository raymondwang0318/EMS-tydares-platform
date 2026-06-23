/**
 * 系統設定頁（M-PM-313 階段2 P4）— 重用既有 /config 空殼 slot。
 *
 * 內容：Mail 通知收件人管理（GET/POST/PATCH/DELETE /v1/admin/mail-recipients）。
 * 收件人會收到「notify_pananora=TRUE 且未解除」事件的 mail（升級降頻 0/4h/12h/24h）。
 * 含 admin + pananora 兩來源（admin 視野看全部）。
 */
import { useState } from 'react';
import {
  Alert, Button, Card, Form, Input, Modal, Switch, Table, Tag, Typography, message,
} from 'antd';
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import {
  useMailRecipients,
  useCreateMailRecipient,
  useUpdateMailRecipient,
  useDeleteMailRecipient,
  type MailRecipient,
} from '../hooks/useMailRecipients';

const { Title, Text } = Typography;

export default function SystemSettings() {
  const { data, isLoading, error } = useMailRecipients();
  const create = useCreateMailRecipient();
  const update = useUpdateMailRecipient();
  const del = useDeleteMailRecipient();
  const [addOpen, setAddOpen] = useState(false);
  const [form] = Form.useForm<{ email: string; description?: string }>();

  const handleAdd = async () => {
    try {
      const v = await form.validateFields();
      await create.mutateAsync({ email: v.email.trim(), description: v.description?.trim() || undefined });
      message.success('已新增收件人');
      setAddOpen(false);
      form.resetFields();
    } catch (e: any) {
      if (e?.errorFields) return;
      message.error(`新增失敗：${e?.response?.data?.detail ?? e?.message ?? '未知錯誤'}`);
    }
  };

  const handleToggle = async (rec: MailRecipient, enabled: boolean) => {
    try {
      await update.mutateAsync({ id: rec.recipient_id, patch: { notify_enabled: enabled } });
    } catch (e: any) {
      message.error(`更新失敗：${e?.response?.data?.detail ?? e?.message ?? '未知錯誤'}`);
    }
  };

  const handleDelete = (rec: MailRecipient) => {
    Modal.confirm({
      title: '刪除收件人',
      content: `確定刪除 ${rec.email}？`,
      okText: '確定刪除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await del.mutateAsync(rec.recipient_id);
          message.success('已刪除');
        } catch (e: any) {
          message.error(`刪除失敗：${e?.response?.data?.detail ?? e?.message ?? '未知錯誤'}`);
          throw e;
        }
      },
    });
  };

  const columns: ColumnsType<MailRecipient> = [
    { title: 'Email', dataIndex: 'email', render: (v) => <Text copyable style={{ fontFamily: 'monospace' }}>{v}</Text> },
    {
      title: '來源', dataIndex: 'source', width: 100,
      render: (s: string) => <Tag color={s === 'pananora' ? 'purple' : 'blue'}>{s}</Tag>,
    },
    { title: '描述', dataIndex: 'description', render: (v) => v || <Text type="secondary">—</Text> },
    {
      title: '啟用通知', dataIndex: 'notify_enabled', width: 100,
      render: (en: boolean, rec) => (
        <Switch checked={en} size="small" onChange={(v) => handleToggle(rec, v)} />
      ),
    },
    {
      title: '操作', key: 'actions', width: 80,
      render: (_, rec) => (
        <Button icon={<DeleteOutlined />} size="small" danger onClick={() => handleDelete(rec)} aria-label="刪除" />
      ),
    },
  ];

  return (
    <div>
      <Title level={3} style={{ marginTop: 0 }}>系統設定</Title>
      <Card
        size="small"
        title="📧 Mail 通知收件人"
        extra={<Button type="primary" icon={<PlusOutlined />} onClick={() => setAddOpen(true)}>新增收件人</Button>}
        style={{ maxWidth: 880 }}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="收件人會收到「需通知 Pananora 且未解除」的異常事件 mail"
          description="發送策略：觸發即發 → 4 小時 → 12 小時 → 24 小時（之後固定 24 小時）重發，事件解除後停止。SMTP 伺服器設定由系統管理員於 .env 配置。"
        />
        {error && (
          <Alert type="error" showIcon style={{ marginBottom: 12 }}
            message="載入收件人失敗" description={String((error as any)?.message ?? error)} />
        )}
        <Table<MailRecipient>
          rowKey="recipient_id"
          columns={columns}
          dataSource={data ?? []}
          loading={isLoading}
          size="small"
          pagination={false}
          locale={{ emptyText: '尚無收件人；點「新增收件人」加入' }}
        />
      </Card>

      <Modal
        title="新增 Mail 收件人"
        open={addOpen}
        onOk={handleAdd}
        onCancel={() => { setAddOpen(false); form.resetFields(); }}
        okText="新增"
        cancelText="取消"
        confirmLoading={create.isPending}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item
            name="email"
            label="Email"
            rules={[
              { required: true, message: '請輸入 email' },
              { type: 'email', message: 'email 格式不正確' },
            ]}
          >
            <Input placeholder="例：ops@tydares.com" autoFocus />
          </Form.Item>
          <Form.Item name="description" label="描述（選填）" rules={[{ max: 255 }]}>
            <Input placeholder="例：維運值班信箱" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
