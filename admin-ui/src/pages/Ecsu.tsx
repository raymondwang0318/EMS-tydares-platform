/**
 * 用電計費單位 (ECSU) — M-PM-219 T-AdminUI-010 §二 補強版
 *
 * 既有頁面（M-P11-061 §三）原用 CrudTable；本卷重寫獨立 component 以支援：
 * - per-row API call columns（綁定數 / 即時 kW / 本月 kWh）
 * - 樹狀展開（parent_id 自參照）
 * - 編輯 dialog 對齊 schema 6 欄含 enabled toggle
 * - 刪除 Popconfirm 防誤刪 + 提示子 ECSU 處置（409 handling）
 *
 * 對接 backend M-P12-046 既有 8 endpoints（見 useEcsu.ts）
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button, Form, Input, InputNumber, Modal, Popconfirm, Space,
  Spin, Switch, Table, Tag, Typography, message,
} from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, ReloadOutlined, LinkOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import {
  useEcsuList,
  useEcsuCircuits,
  useEcsuRealtime,
  useEcsuMonthly,
  useCreateEcsu,
  useUpdateEcsu,
  useDeleteEcsu,
  buildEcsuTree,
  type EcsuRow,
  type EcsuFormBody,
} from '../hooks/useEcsu';

const { Title, Text } = Typography;

// Per-row stats column render（每 row 自己 fetch；react-query cache）
function CircuitsCountCell({ ecsuId }: { ecsuId: number }) {
  const { data, isLoading } = useEcsuCircuits(ecsuId);
  if (isLoading) return <Spin size="small" />;
  return <Text>{data?.count ?? '—'}</Text>;
}

function RealtimeKwCell({ ecsuId }: { ecsuId: number }) {
  const { data, isLoading } = useEcsuRealtime(ecsuId);
  if (isLoading) return <Spin size="small" />;
  const v = data?.realtime_kw;
  if (v == null) return <Text type="secondary">—</Text>;
  // 警示色：> 0 綠；< 0 橘（反向潮流）；= 0 灰
  const color = v > 0.001 ? '#4caf50' : v < -0.001 ? '#ff9800' : undefined;
  return <Text style={{ color, fontFamily: 'monospace' }}>{v.toFixed(2)}</Text>;
}

function MonthlyKwhCell({ ecsuId }: { ecsuId: number }) {
  const { data, isLoading } = useEcsuMonthly(ecsuId);
  if (isLoading) return <Spin size="small" />;
  const v = data?.monthly_kwh;
  if (v == null) return <Text type="secondary">—</Text>;
  return <Text style={{ fontFamily: 'monospace' }}>{v.toFixed(1)}</Text>;
}

export default function Ecsu() {
  const navigate = useNavigate();
  const { data: rows, isLoading, refetch } = useEcsuList();
  const createMut = useCreateEcsu();
  const updateMut = useUpdateEcsu();
  const deleteMut = useDeleteEcsu();

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<EcsuRow | null>(null);
  const [form] = Form.useForm<EcsuFormBody>();

  // 樹狀資料（parent_id 自參照；antd Table expandable）
  const treeData = useMemo(() => buildEcsuTree(rows ?? []), [rows]);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({
      ecsu_code: '',
      ecsu_name: '',
      parent_id: null,
      display_seq: 1,
      enabled: true,
      remark_desc: '',
    });
    setModalOpen(true);
  };

  const openEdit = (row: EcsuRow) => {
    setEditing(row);
    form.resetFields();
    form.setFieldsValue({
      ecsu_code: row.ecsu_code,
      ecsu_name: row.ecsu_name,
      parent_id: row.parent_id,
      display_seq: row.display_seq,
      enabled: row.enabled,
      remark_desc: row.remark_desc ?? '',
    });
    setModalOpen(true);
  };

  const handleSubmit = async () => {
    try {
      const body = await form.validateFields();
      if (editing) {
        await updateMut.mutateAsync({ ecsu_id: editing.ecsu_id, ...body });
        message.success(`ECSU「${body.ecsu_code}」更新成功`);
      } else {
        await createMut.mutateAsync(body);
        message.success(`ECSU「${body.ecsu_code}」建立成功`);
      }
      setModalOpen(false);
      setEditing(null);
    } catch (err) {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      const detail = e?.response?.data?.detail ?? e?.message;
      if (detail) message.error(`操作失敗：${detail}`);
    }
  };

  const handleDelete = async (row: EcsuRow) => {
    try {
      await deleteMut.mutateAsync(row.ecsu_id);
      message.success(`ECSU「${row.ecsu_code}」已刪除`);
    } catch (err) {
      const e = err as { response?: { status?: number; data?: { detail?: string } } };
      const status = e?.response?.status;
      const detail = e?.response?.data?.detail;
      if (status === 409) {
        message.error(`刪除失敗：${detail ?? '此 ECSU 有子節點或綁定迴路；請先處置'}`);
      } else {
        message.error(`刪除失敗：${detail ?? '未知錯誤'}`);
      }
    }
  };

  const columns: ColumnsType<EcsuRow & { children?: EcsuRow[] }> = [
    { title: 'ID', dataIndex: 'ecsu_id', key: 'ecsu_id', width: 70 },
    { title: '代碼', dataIndex: 'ecsu_code', key: 'ecsu_code', width: 130 },
    { title: '名稱', dataIndex: 'ecsu_name', key: 'ecsu_name' },
    {
      title: '上層 ID',
      dataIndex: 'parent_id',
      key: 'parent_id',
      width: 80,
      render: (v: number | null) => (v ?? <Text type="secondary">—</Text>),
    },
    {
      title: '綁定數',
      key: 'circuits_count',
      width: 80,
      align: 'right',
      render: (_: unknown, row) => <CircuitsCountCell ecsuId={row.ecsu_id} />,
    },
    {
      title: '即時 (kW)',
      key: 'realtime_kw',
      width: 100,
      align: 'right',
      render: (_: unknown, row) => <RealtimeKwCell ecsuId={row.ecsu_id} />,
    },
    {
      title: '本月 (kWh)',
      key: 'monthly_kwh',
      width: 110,
      align: 'right',
      render: (_: unknown, row) => <MonthlyKwhCell ecsuId={row.ecsu_id} />,
    },
    { title: '顯示順序', dataIndex: 'display_seq', key: 'display_seq', width: 90, align: 'right' },
    {
      title: '狀態',
      dataIndex: 'enabled',
      key: 'enabled',
      width: 80,
      render: (v: boolean) =>
        v ? <Tag color="green">啟用</Tag> : <Tag color="default">停用</Tag>,
    },
    {
      title: '操作',
      key: 'action',
      width: 200,
      render: (_: unknown, row) => (
        <Space size={4}>
          {/* M-PM-220 §三：詳情頁入口 */}
          <Button
            size="small"
            type="link"
            icon={<LinkOutlined />}
            onClick={() => navigate(`/ecsu/${row.ecsu_id}`)}
          >
            綁定
          </Button>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)}>
            編輯
          </Button>
          <Popconfirm
            title={`刪除 ECSU「${row.ecsu_code}」？`}
            description="若有子節點 / 綁定迴路將回 409 提示處置。"
            okText="確認刪除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={() => handleDelete(row)}
          >
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Title level={3} style={{ marginTop: 0 }}>用電計費單位 (ECSU)</Title>
      <Space style={{ marginBottom: 16 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          新增 ECSU
        </Button>
        <Button icon={<ReloadOutlined />} onClick={() => refetch()}>
          重新整理
        </Button>
        <Text type="secondary" style={{ fontSize: 12 }}>
          M-PM-219 §二補強：含綁定迴路數 / 即時 kW（30s 自動更新）/ 本月累積 kWh
        </Text>
      </Space>

      <Table<EcsuRow & { children?: EcsuRow[] }>
        rowKey="ecsu_id"
        columns={columns}
        dataSource={treeData}
        loading={isLoading}
        size="small"
        pagination={false}
        expandable={{ defaultExpandAllRows: true }}
      />

      <Modal
        title={editing ? `編輯 ECSU - ${editing.ecsu_code}` : '新增 ECSU'}
        open={modalOpen}
        onCancel={() => {
          setModalOpen(false);
          setEditing(null);
        }}
        onOk={handleSubmit}
        confirmLoading={createMut.isPending || updateMut.isPending}
        destroyOnHidden
        width={520}
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item
            name="ecsu_code"
            label="代碼"
            rules={[{ required: true, message: '代碼必填' }]}
          >
            <Input placeholder="例：KW-01" disabled={!!editing} />
          </Form.Item>
          <Form.Item
            name="ecsu_name"
            label="名稱"
            rules={[{ required: true, message: '名稱必填' }]}
          >
            <Input placeholder="例：農技大樓總幹線" />
          </Form.Item>
          <Form.Item name="parent_id" label="上層 ID（選填；樹狀層級）">
            <InputNumber style={{ width: '100%' }} placeholder="若為根節點留空" />
          </Form.Item>
          <Form.Item name="display_seq" label="顯示順序">
            <InputNumber style={{ width: '100%' }} min={1} />
          </Form.Item>
          <Form.Item name="enabled" label="啟用" valuePropName="checked">
            <Switch checkedChildren="啟用" unCheckedChildren="停用" />
          </Form.Item>
          <Form.Item name="remark_desc" label="備註">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
