import { Alert } from 'antd';
import CrudTable from '../components/CrudTable';

/**
 * Modbus 設備管理（全站唯讀總覽）
 *
 * T-P11-003 對齊 V2-final `/v1/admin/devices` schema（ADR-026 ems_device 結構）：
 * - V2 回傳 keys: device_id / edge_id / device_kind / display_name / model_id / config_version / enabled
 * - 不再是 Oracle legacy key（modbus_device_id / modbus_device_code / modbus_device_name ...）
 * - 結果：cells 不再空白（M-PM-061 §3.2 demo rescue 小瑕疵修復）
 *
 * 老王 2026-04-23 裁決（選項 A）：
 * - 新增設備走 Edge 管理頁 → Wizard（hideAdd）
 * - 本頁僅全站唯讀 + 改 display_name（透過 PATCH /admin/devices/{id}/name）
 */

const columns = [
  { title: '設備 ID', dataIndex: 'device_id', key: 'device_id' },
  { title: '所屬 Edge', dataIndex: 'edge_id', key: 'edge_id', width: 140 },
  { title: '類別', dataIndex: 'device_kind', key: 'device_kind', width: 120 },
  { title: '顯示名稱', dataIndex: 'display_name', key: 'display_name' },
  { title: '型號 ID', dataIndex: 'model_id', key: 'model_id', width: 100, render: (v: number | null) => (v ?? '—') },
  { title: 'Config Ver', dataIndex: 'config_version', key: 'config_version', width: 100 },
  {
    title: '狀態',
    dataIndex: 'enabled',
    key: 'enabled',
    width: 80,
    render: (v: boolean) => (v ? '啟用' : '停用'),
  },
];

// 編輯欄位只留 display_name（其他識別性欄位由 Wizard 掃描匯入決定）
const formFields = [
  { name: 'display_name', label: '顯示名稱', type: 'text' as const, required: true },
];

export default function ModbusDevices() {
  return (
    <CrudTable
      title="Modbus 設備"
      apiPath="/admin/devices"
      columns={columns}
      formFields={formFields}
      rowKey="device_id"
      hideAdd
      hideDelete
      hintText={
        <Alert
          type="info"
          showIcon
          message="新增 Modbus 設備請走 Edge 管理頁 → 選 Edge → 點「掃描設備」Wizard"
          description="本頁為全站設備唯讀總覽；手動編輯限制在「顯示名稱」（其他識別性欄位由 Wizard 掃描匯入決定，避免 dirty data）"
        />
      }
    />
  );
}
