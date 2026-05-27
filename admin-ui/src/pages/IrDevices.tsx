/**
 * IR (811C) 標籤管理頁 — 全站 IR 設備唯讀總覽 + 編輯 display_name。
 *
 * T-S11C-001 AC 5（M-PM-074 P11 scope）：
 * - 不新增 / 不刪除（811C 不註冊 ems_device；新增由 trx_reading 派生）
 * - 編輯欄位只有 display_name
 * - 未命名 → 橘色警告「請填寫名稱代號以利辨識」
 *
 * M-PM-277 UI 調整：
 * - 依 TC01~TC16 排列（display_name 尾部 TCxx 解析排序）
 * - 欄位：編號 / 安裝區域 / 安裝位置 / IP地址 / MAC / 最後上報時間 / 操作
 * - IP 地址欄位待後端擴充；目前顯示「—」
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

// ─── display_name 解析 ───────────────────────────────────────────────
// 預期格式：「{區域}-{位置}-TC{num}」，例：「D區-ML上-TC01」
// 部分設備可能只有「TC01」（位置未設定）

interface ParsedName {
  tcNum: number | null;  // 1~16，排序用
  tcCode: string;        // "TC01"~"TC16"，或「—」
  zone: string;          // "D區"
  location: string;      // "ML上"
}

function parseDisplayName(dn: string | null): ParsedName {
  if (!dn) return { tcNum: null, tcCode: '—', zone: '—', location: '—' };

  const tcMatch = dn.match(/TC(\d{1,2})$/i);
  const tcNum = tcMatch ? parseInt(tcMatch[1], 10) : null;
  const tcCode = tcNum != null ? `TC${String(tcNum).padStart(2, '0')}` : '—';

  // 去掉 "-TCxx" 後綴
  const base = dn.replace(/-?TC\d{1,2}$/i, '').trim();
  if (!base) return { tcNum, tcCode, zone: '—', location: '—' };

  // 第一個 "-" 前為區域，其後為位置
  const dashIdx = base.indexOf('-');
  if (dashIdx === -1) return { tcNum, tcCode, zone: base, location: '—' };

  return {
    tcNum,
    tcCode,
    zone: base.substring(0, dashIdx),
    location: base.substring(dashIdx + 1),
  };
}

// MAC 格式化：去掉 "811c_" 前綴
function formatMac(deviceId: string): string {
  return deviceId.replace(/^811c_/i, '');
}

// ─── 排序：TC01 → TC16，未解析 TCxx 者排最後 ──────────────────────────
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

// ─── Component ────────────────────────────────────────────────────────

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
        return zone === '—'
          ? <Text type="secondary">—</Text>
          : <span>{zone}</span>;
      },
    },
    {
      title: '安裝位置',
      key: 'location',
      render: (_, rec) => {
        if (isIrUnnamed(rec)) {
          return <Tag color="orange">⚠ 未命名 — 請填寫名稱代號以利辨識</Tag>;
        }
        const { location } = parseDisplayName(rec.display_name);
        return location === '—'
          ? <Text type="secondary">—</Text>
          : <span>{location}</span>;
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

  const sortedData = sortByTcNum(data ?? []);

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
        description="填寫名稱代號（display_name）即納入健康監控；未命名設備不觸發離線告警（ADR-028 DR-028-02）。MAC 僅作系統識別用，不出現在報表前台。IP 地址欄位待後端版本擴充。"
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
        dataSource={sortedData}
        loading={isLoading}
        size="middle"
        pagination={{ pageSize: 20 }}
        locale={{ emptyText: 'trx_reading 尚無 811c_* 資料；待 Edge 採集累積或老王連網更多 IR 設備' }}
      />

      {/* 編輯 display_name Modal — 追加 / 修改 811C 安裝位置標籤 */}
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
            extra="格式：{區域}-{位置}-TC{編號}，例：D區-ML上-TC01 / E區-TR1-100-TC08"
          >
            <Input placeholder="例：D區-ML上-TC01" autoFocus />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
