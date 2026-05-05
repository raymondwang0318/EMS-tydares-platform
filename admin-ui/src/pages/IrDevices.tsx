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
import { useMemo, useState } from 'react';
import { Alert, Button, Form, Input, Modal, Select, Table, Tag, Typography, message } from 'antd';
import { EditOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import {
  useIrDevices,
  useUpsertIrLabel,
  isIrUnnamed,
  getIrEdgeId,
  FALLBACK_EDGE_ID,
  type IrDevice,
} from '../hooks/useIrDevices';
import { useEdges } from '../hooks/useEdges';

const { Title, Text } = Typography;

export default function IrDevices() {
  const { data, isLoading, error } = useIrDevices();
  const { data: edgesData } = useEdges();
  const upsert = useUpsertIrLabel();
  const [editing, setEditing] = useState<IrDevice | null>(null);
  const [form] = Form.useForm<{ display_name: string; edge_id: string }>();

  // M-PM-111 軌 A③.1：active edges 作為編輯下拉選項
  // status 在 'approved' / 'maintenance' 視為可掛載 IR 設備；其他（pending/revoked）排除
  const edgeOptions = useMemo(() => {
    const list = (edgesData ?? []).filter(
      (e) => e.status === 'approved' || e.status === 'maintenance',
    );
    // 過渡期保證 fallback edge 一定在選單裡（即使 list 為空也能編輯）
    if (!list.find((e) => e.edge_id === FALLBACK_EDGE_ID)) {
      list.unshift({
        edge_id: FALLBACK_EDGE_ID,
        edge_name: '農技大樓 Edge01（fallback）',
        site_code: null,
        hostname: null,
        fingerprint: null,
        previous_fingerprints: [],
        status: 'approved',
        last_seen_ip: null,
        last_seen_at: null,
        config_version: 0,
        registered_at: null,
        approved_at: null,
        approved_by: null,
        maintenance_at: null,
        replaced_at: null,
        revoked_at: null,
        revoked_reason: null,
        remark_desc: null,
      });
    }
    return list.map((e) => ({
      value: e.edge_id,
      label: e.edge_name ? `${e.edge_id} · ${e.edge_name}` : e.edge_id,
    }));
  }, [edgesData]);

  const handleEdit = (rec: IrDevice) => {
    setEditing(rec);
    form.setFieldsValue({
      display_name: rec.display_name ?? '',
      edge_id: getIrEdgeId(rec),
    });
  };

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      if (!editing) return;
      await upsert.mutateAsync({
        device_id: editing.device_id,
        display_name: values.display_name.trim(),
        edge_id: values.edge_id,
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
      // M-PM-111 軌 A③.1：所屬 Edge column（軌 A①schema migration 完成後 backend 自動回真值；
      // 過渡期 getIrEdgeId fallback 'TYDARES-E66'；UI 標 fallback Tag）
      title: '所屬 Edge',
      dataIndex: 'edge_id',
      key: 'edge_id',
      width: 200,
      render: (_v, rec) => {
        const eid = getIrEdgeId(rec);
        const isFallback = !rec.edge_id;
        const edgeName = (edgesData ?? []).find((e) => e.edge_id === eid)?.edge_name;
        const display = edgeName ? `${eid} · ${edgeName}` : eid;
        return isFallback ? (
          <Tag color="default" title="後端尚未回傳 edge_id；過渡期 fallback（軌 A① 完成後自動切真值）">
            {display}
          </Tag>
        ) : (
          <Text>{display}</Text>
        );
      },
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
          {/* M-PM-111 軌 A③.1：edge_id Select（從 useEdges() active edges 派生）*/}
          <Form.Item
            name="edge_id"
            label="所屬 Edge"
            rules={[{ required: true, message: '請選擇所屬 Edge' }]}
            extra="此 IR 設備掛載於哪個 Edge 主機；用於 Reports thermal 分群與 alert 抑制邏輯"
          >
            <Select options={edgeOptions} placeholder="選擇 Edge" showSearch optionFilterProp="label" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
