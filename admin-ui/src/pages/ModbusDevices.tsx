import { Alert } from 'antd';
import CrudTable from '../components/CrudTable';

/**
 * Modbus 設備管理（全站唯讀總覽）
 *
 * 老王 2026-04-23 裁決（選項 A）：
 * - 新增設備走 Edge 管理頁 → 每列「掃描設備」Wizard（M-PM-043 / T-Meta-005-a）
 * - 本頁僅保留：全站設備列表 + 編輯（只能改 name / remark）+ 刪除
 * - 不顯示 slave_id / hub_id / device_model_id 編輯（避免 dirty data 衝突）
 *
 * V2-final endpoint 對齊：/admin/modbus-devices → /admin/devices（baseURL /v1）
 */

const columns = [
  { title: 'ID', dataIndex: 'modbus_device_id', key: 'modbus_device_id', width: 80 },
  { title: 'UID', dataIndex: 'device_uid', key: 'device_uid' },
  { title: '設備代碼', dataIndex: 'modbus_device_code', key: 'modbus_device_code' },
  { title: '設備名稱', dataIndex: 'modbus_device_name', key: 'modbus_device_name' },
  { title: 'Slave ID', dataIndex: 'slave_id', key: 'slave_id', width: 80 },
  { title: '型號 ID', dataIndex: 'modbus_device_model_id', key: 'modbus_device_model_id', width: 100 },
  { title: '狀態', dataIndex: 'status', key: 'status', width: 80 },
];

// 編輯欄位只留 name / remark；slave_id / hub_id / model_id 等識別性欄位由 Wizard 掃描匯入決定
const formFields = [
  { name: 'modbus_device_name', label: '設備名稱', type: 'text' as const, required: true },
  { name: 'remark_desc', label: '備註', type: 'textarea' as const },
];

export default function ModbusDevices() {
  return (
    <CrudTable
      title="Modbus 設備"
      apiPath="/admin/devices"
      columns={columns}
      formFields={formFields}
      rowKey="modbus_device_id"
      hideAdd
      hintText={
        <Alert
          type="info"
          showIcon
          message="新增 Modbus 設備請走 Edge 管理頁 → 選 Edge → 點「掃描設備」Wizard"
          description="本頁為全站設備唯讀總覽；手動編輯限制在 設備名稱 / 備註（其他識別性欄位由 Wizard 掃描匯入決定，避免 dirty data）"
        />
      }
    />
  );
}
