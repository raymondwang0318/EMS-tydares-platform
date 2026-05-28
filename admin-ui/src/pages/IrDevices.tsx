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
import { Alert, Button, Form, Input, Modal, Select, Space, Table, Tag, Typography, message } from 'antd';
import { EditOutlined, DeleteOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import {
  useIrDevices,
  useUpsertIrLabel,
  useArchiveIrDevice,
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

// 空 TC slot（老王 5/28：編號固定列 TC01~TC16，無內容留空）
type EmptySlot = { __empty: true; __tc: number; device_id: string };
type TcRow = IrDevice | EmptySlot;

function isEmptySlot(r: TcRow): r is EmptySlot {
  return (r as EmptySlot).__empty === true;
}

// 固定 16 row（TC01~TC16）框架；命名好的 device 填入對應 slot；
// 未命名 device（無 tcNum）append 在 16 row 之後（保留可見性 + ⚠ 未命名警告）
function buildTcRows(devices: IrDevice[]): TcRow[] {
  const byTc = new Map<number, IrDevice>();
  const unnamed: IrDevice[] = [];
  for (const d of devices) {
    const { tcNum } = parseDisplayName(d.display_name);
    if (tcNum != null && tcNum >= 1 && tcNum <= 16) {
      byTc.set(tcNum, d);
    } else {
      unnamed.push(d);
    }
  }
  const rows: TcRow[] = [];
  for (let n = 1; n <= 16; n++) {
    const d = byTc.get(n);
    rows.push(d ?? { __empty: true, __tc: n, device_id: `__tcslot_${n}` });
  }
  return [...rows, ...unnamed];
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
  const archive = useArchiveIrDevice();
  const [editing, setEditing] = useState<IrDevice | null>(null);
  const [form] = Form.useForm<EditFormValues>();

  // M-P12-077 老王 5/28：移除已取消安裝的 811C（soft archive；二次確認 v1.4 §61）
  const handleArchive = (rec: IrDevice) => {
    const { tcCode, zone, location } = parseDisplayName(rec.display_name);
    const label = tcCode !== '—' ? `${tcCode}（${zone}-${location}）` : rec.device_id;
    Modal.confirm({
      title: '移除 IR 設備',
      okText: '確定移除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      content: (
        <div>
          <p>確定移除 <strong>{label}</strong>？</p>
          <p style={{ color: '#888', fontSize: 13 }}>
            MAC: {formatMac(rec.device_id)}<br />
            歷史熱像資料保留；僅從列表隱藏。<br />
            若日後重新安裝同一顆（同 MAC）並重新上報，會自動復原顯示。
          </p>
        </div>
      ),
      onOk: async () => {
        try {
          await archive.mutateAsync(rec.device_id);
          message.success('已移除');
        } catch (e: any) {
          message.error(`移除失敗：${e?.response?.data?.detail ?? e?.message ?? '未知錯誤'}`);
          throw e; // 保持 Modal 開啟
        }
      },
    });
  };

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

  const EMPTY = <Text type="secondary">—</Text>;

  const columns: ColumnsType<TcRow> = [
    {
      title: '編號',
      key: 'tc_code',
      width: 70,
      render: (_, rec) => {
        if (isEmptySlot(rec)) {
          // 空 slot：編號固定顯 TCxx（框架；老王 5/28）
          return <Text strong>TC{String(rec.__tc).padStart(2, '0')}</Text>;
        }
        const { tcCode } = parseDisplayName(rec.display_name);
        return tcCode === '—'
          ? <Text type="secondary">—</Text>
          : <Text strong>{tcCode}</Text>;
      },
    },
    {
      title: '安裝區域',
      key: 'zone',
      width: 120,
      render: (_, rec) => {
        if (isEmptySlot(rec)) return EMPTY;
        const { zone } = parseDisplayName(rec.display_name);
        return zone === '—' ? EMPTY : <span>{zone}</span>;
      },
    },
    {
      title: '安裝位置',
      key: 'location',
      width: 200,
      render: (_, rec) => {
        if (isEmptySlot(rec)) return EMPTY;
        if (isIrUnnamed(rec)) return <Tag color="orange">⚠ 未命名</Tag>;
        const { location } = parseDisplayName(rec.display_name);
        return location === '—' ? EMPTY : <span>{location}</span>;
      },
    },
    {
      title: 'IP 地址',
      key: 'ip',
      width: 130,
      render: (_, rec) =>
        !isEmptySlot(rec) && rec.ip_address
          ? <Text style={{ fontFamily: 'monospace' }}>{rec.ip_address}</Text>
          : EMPTY,
    },
    {
      title: 'MAC',
      key: 'mac',
      width: 160,
      // 老王 5/28 明示：MAC 文字樣式對齊 IP 地址（黑色正常大小 monospace;移除 secondary 灰 + 小字）
      render: (_, rec) =>
        isEmptySlot(rec)
          ? EMPTY
          : <Text style={{ fontFamily: 'monospace' }}>{formatMac(rec.device_id)}</Text>,
    },
    {
      title: '最後上報時間',
      key: 'last_seen',
      width: 170,
      render: (_, rec) =>
        !isEmptySlot(rec) && rec.last_seen
          ? dayjs(rec.last_seen).format('YYYY-MM-DD HH:mm:ss')
          : EMPTY,
    },
    {
      title: '操作',
      key: 'actions',
      width: 110,
      render: (_, rec) =>
        isEmptySlot(rec)
          ? EMPTY
          : (
            <Space size="small">
              <Button
                icon={<EditOutlined />}
                size="small"
                onClick={() => handleEdit(rec)}
                aria-label="編輯"
              />
              <Button
                icon={<DeleteOutlined />}
                size="small"
                danger
                onClick={() => handleArchive(rec)}
                aria-label="移除"
              />
            </Space>
          ),
    },
  ];

  // M-P11-E36 老王 5/28 明示：欄位向左縮、不撐滿整頁
  // columns 總寬 = 70+120+200+130+160+170+110 = 960（操作欄加刪除按鈕 70→110）;外層 maxWidth 限制 table 不 stretch
  const TABLE_MAX_WIDTH = 980;

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
      <div style={{ maxWidth: TABLE_MAX_WIDTH }}>
        <Table<TcRow>
          rowKey="device_id"
          columns={columns}
          dataSource={buildTcRows(data ?? [])}
          loading={isLoading}
          size="middle"
          tableLayout="fixed"
          pagination={{ pageSize: 20 }}
          locale={{ emptyText: 'trx_reading 尚無 811c_* 資料；待 Edge 採集後自動出現' }}
        />
      </div>

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
