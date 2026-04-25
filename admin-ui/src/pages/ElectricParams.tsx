import { Alert } from 'antd';
import CrudTable from '../components/CrudTable';

/**
 * 電力參數（元數據）
 *
 * T-P11-003 對齊 V2-final `/v1/admin/electric-parameters` schema（v1_admin.py list_electric_parameters）：
 * - V2 keys: electric_parameter_id / parameter_code / parameter_name / uom_name / data_type / decimal_place / parameter_category
 * - 與 legacy 主要差異：parameter_code（非 electric_parameter_code）/ parameter_name（非 electric_parameter_name）
 * - apiPath 從 legacy `/admin/electric-params`（回 null）→ V2 `/admin/electric-parameters`
 *
 * V2-final 目前**無 POST / PUT / DELETE**（parameter 是協議元數據，不該 UI 編輯）：
 * - hideAdd + hideEdit + hideDelete 三旗標
 */

const columns = [
  { title: 'ID', dataIndex: 'electric_parameter_id', key: 'electric_parameter_id', width: 80 },
  { title: '參數代碼', dataIndex: 'parameter_code', key: 'parameter_code' },
  { title: '參數名稱', dataIndex: 'parameter_name', key: 'parameter_name' },
  { title: '單位', dataIndex: 'uom_name', key: 'uom_name', width: 100 },
  { title: '資料型別', dataIndex: 'data_type', key: 'data_type', width: 120 },
  { title: '小數位', dataIndex: 'decimal_place', key: 'decimal_place', width: 100 },
  { title: '分類', dataIndex: 'parameter_category', key: 'parameter_category' },
];

const formFields: never[] = [];

export default function ElectricParams() {
  return (
    <CrudTable
      title="電力參數"
      apiPath="/admin/electric-parameters"
      columns={columns}
      formFields={formFields}
      rowKey="electric_parameter_id"
      hideAdd
      hideEdit
      hideDelete
      hintText={
        <Alert
          type="info"
          showIcon
          message="V2-final 電力參數為唯讀"
          description="參數是通訊協議元數據，由 migration 管理；UI 僅顯示；手動編輯會污染跨設備資料模型"
        />
      }
    />
  );
}
