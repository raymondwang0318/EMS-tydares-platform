/**
 * IR (811C) 標籤管理頁 — 全站 IR 設備唯讀總覽 + 分欄位編輯。
 *
 * T-S11C-001 AC 5（M-PM-074 P11 scope）：
 * - 不新增 / 不刪除（811C 不註冊 ems_device；新增由 trx_reading 派生）
 * - 編輯：TC 編號（Select）/ 安裝區域（Input）/ 安裝位置（Input）分開輸入
 *   儲存時組合為 display_name：{區域}-{位置}-TC{num}
 * - 未命名 → 橘色警告
 *
 * M-PM-277 UI 調整：
 * - 依 TC01~TC16 排列
 * - 欄位：編號 / 安裝區域 / 安裝位置 / IP地址 / MAC / 最後上報時間 / 操作
 * - IP 地址欄位待後端擴充；目前顯示「—」
 */
import { useState } from 'react';
import { Alert, Button, Form, Input, Modal, Select, Table, Tag, Typography, message } from 'antd';
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

// ─── display_name 解析 ────────────────────────────────────────────────
// 格式：「{區域}-{位置}-TC{num}」，例：「D區-ML上-TC01」

interface ParsedName {
  tcNum: number | null;
  tcCode: string;
  zone: string;
  location: string;
}

function parseDisplayName(dn: string | null): ParsedName {
  if (!dn) return { tcNum: null, tcCode: '—', zone: '—', location: '—' };

  const tcMatch = dn.match(/TC(\d{1,2})$/i);
  const tcNum = tcMatch ? parseInt(tcMatch[1], 10) : null;
  const tcCode = tcNum != null ? `TC${String(tcNum).padStart(2, '0')}` : '—';

  const base = dn.replace(/-?TC\d{1,2}$/i, '').trim();
  if (!base) return { tcNum, tcCode, zone: '—', location: '—' };

  const dashIdx = base.indexOf('-');
  if (dashIdx === -1) return { tcNum, tcCode, zone: base, location: '—' };

  return {
    tcNum,
    tcCode,
    zone: base.substring(0, dashIdx),
    location: base.substring(dashIdx + 1),
  };
}

function formatMac(deviceId: string): string {
  return deviceId.replace(/^811c_/i, '');
}

function sortByTcNum(devices: IrDevice[]): IrDevice[] {
  return [...devices].sort((a, b) => {
    const na = parseDisplayName(a.display_name).tcNum;
    const nb = parseDisplayName(b.display_name).tcNum;
    if (na == null && nb == null) return 0;
    if (na == null) return 1;
    if (nb == null) return -1;
    return na - nb;
  });
}

// TC01~TC16 下拉選項
const TC_OPTIONS = Array.from({ length: 16 }, (_, i) => {
  const n = i + 1;
  const code = `TC${String(n).padStart(2, '0')}`;
  return { value: n, label: code };
});

// ─── Component ────────────────────────────────────────────────────────

interface EditFormValues {
  tc_num: number;
  zone: string;
  location: string;
}

export default function IrDevices() {
  const { data, isLoading, error } = useIrDevices();
  const upsert = useUpsertIrLabel();
  const [editing, setEditing] = useState<IrDevice | null>(null);
  const [form] = Form.useForm<EditFormValues>();

  const handleEdit = (rec: IrDevice) => {
    setEditing(rec);
    const { tcNum, zone, location } = parseDisplayName(rec.display_name);
    form.setFieldsValue({
      tc_num: tcNum ?? undefined,
      zone: zone === '—' ? '' : zone,
      location: location === '—' ? '' : location,
    });
  };

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      if (!editing) return;
      const padded = String(values.tc_num).padStart(2, '0');
      const display_name = `${values.zone.trim()}-${values.location.trim()}-TC${padded}`;
      await upsert.mutateAsync({ device_id: editing.device_id, display_name });
      message.success('已更新');
      setEditing(null);
    } catch (e: any) {
      if (e?.errorFields) return;
      message.error(`更新失敗：${e?.response?.data?.detail ?? e?.message ?? '未知錯誤'}`);
    }
  };

  const columns: ColumnsType<IrDevice> = [
    {
      title: '編號',
      key: 'tc_code',
      width: 80,
      render: (_, rec) => {
        const { tcCode } = parseDisplayName(rec.display_name);
        return tcCode === '—'
          ? <Text type="secondary">—</Text>
          : <Text strong>{tcCode}</Text>;
      },
    },
    {
      title: '安裝區域',
      key: 'zone',
      width: 110,
      render: (_, rec) => {
        const { zone } = parseDisplayName(rec.display_name);
        return zone === '—' ? <Text type="secondary">—</Text> : <span>{zone}</span>;
      },
    },
    {
      title: '安裝位置',
      key: 'location',
      render: (_, rec) => {
        if (isIrUnnamed(rec)) return <Tag color="orange">⚠ 未命名</Tag>;
        const { location } = parseDisplayName(rec.display_name);
        return location === '—' ? <Text type="secondary">—</Text> : <span>{location}</span>;
      },
    },
    {
      title: 'IP 地址',
      key: 'ip',
      width: 140,
      render: (_, rec) =>
        rec.ip_address
          ? <Text style={{ fontFamily: 'monospace' }}>{rec.ip_address}</Text>
          : <Text type="secondary">—</Text>,
    },
    {
      title: 'MAC',
      dataIndex: 'device_id',
      key: 'mac',
      width: 180,
      render: (v: string) => (
        <Text type="secondary" style={{ fontSize: 12, fontFamily: 'monospace' }}>
          {formatMac(v)}
        </Text>
      ),
    },
    {
      title: '最後上報時間',
      dataIndex: 'last_seen',
      key: 'last_seen',
      width: 180,
      render: (v: string | null) =>
        v ? dayjs(v).format('YYYY-MM-DD HH:mm:ss') : <Text type="secondary">—</Text>,
    },
    {
      title: '操作',
      key: 'actions',
      width: 80,
      render: (_, rec) => (
        <Button
          icon={<EditOutlined />}
          size="small"
          onClick={() => handleEdit(rec)}
          aria-label="編輯"
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
        description="設定編號 / 安裝區域 / 安裝位置即納入健康監控；未命名設備不觸發離線告警。IP 地址待後端版本擴充。"
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
        dataSource={sortByTcNum(data ?? [])}
        loading={isLoading}
        size="middle"
        pagination={{ pageSize: 20 }}
        locale={{ emptyText: 'trx_reading 尚無 811c_* 資料；待 Edge 採集後自動出現' }}
      />

      <Modal
        title={`設定安裝資訊 — ${editing?.device_id ?? ''}`}
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
            name="tc_num"
            label="TC 編號"
            rules={[{ required: true, message: '請選擇 TC 編號' }]}
          >
            <Select
              options={TC_OPTIONS}
              placeholder="選擇 TC01 ~ TC16"
              style={{ width: 160 }}
            />
          </Form.Item>
          <Form.Item
            name="zone"
            label="安裝區域"
            rules={[
              { required: true, message: '請輸入安裝區域' },
              { max: 30, message: '不超過 30 字' },
            ]}
          >
            <Input placeholder="例：D區" autoFocus />
          </Form.Item>
          <Form.Item
            name="location"
            label="安裝位置"
            rules={[
              { required: true, message: '請輸入安裝位置' },
              { max: 50, message: '不超過 50 字' },
            ]}
          >
            <Input placeholder="例：ML上 / TR1-100 / TR3-50(下)" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
