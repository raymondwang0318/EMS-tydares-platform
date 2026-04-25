import { Alert } from 'antd';
import CrudTable from '../components/CrudTable';

/**
 * 電價規則（計費規則）
 *
 * T-P11-003 對齊 V2-final `/v1/admin/billing` schema（v1_admin.py list_billing）：
 * - V2 keys: rule_id / rule_kind / rule_code / rule_name / effective_from / effective_to / rule_json / enabled
 * - 與 Oracle legacy fnd_elec_billing_standard 7 欄位完全不同（rule_json 打包多細節）
 * - apiPath 從 legacy `/admin/billing-standard`（回 null）→ V2 `/admin/billing`
 *
 * V2-final 目前**無 POST / PUT / DELETE**（規則由 config / migration 管；UI 僅讀）：
 * - hideAdd + hideEdit + hideDelete 三旗標
 */

const columns = [
  { title: 'ID', dataIndex: 'rule_id', key: 'rule_id', width: 80 },
  { title: '規則類型', dataIndex: 'rule_kind', key: 'rule_kind', width: 140 },
  { title: '代碼', dataIndex: 'rule_code', key: 'rule_code', width: 160 },
  { title: '名稱', dataIndex: 'rule_name', key: 'rule_name' },
  {
    title: '生效起',
    dataIndex: 'effective_from',
    key: 'effective_from',
    width: 120,
    render: (v: string | null) => v ?? '—',
  },
  {
    title: '生效迄',
    dataIndex: 'effective_to',
    key: 'effective_to',
    width: 120,
    render: (v: string | null) => v ?? '—',
  },
  {
    title: '狀態',
    dataIndex: 'enabled',
    key: 'enabled',
    width: 80,
    render: (v: boolean) => (v ? '啟用' : '停用'),
  },
];

// V2 無 POST/PUT/DELETE；formFields 保留結構但不會被啟用
const formFields: never[] = [];

export default function BillingStandard() {
  return (
    <CrudTable
      title="電價規則"
      apiPath="/admin/billing"
      columns={columns}
      formFields={formFields}
      rowKey="rule_id"
      hideAdd
      hideEdit
      hideDelete
      hintText={
        <Alert
          type="info"
          showIcon
          message="V2-final 規則管理為唯讀"
          description="電價規則由 config / migration 管理（rule_json 打包規則細節）；本頁僅顯示；未來有管理需求再擴 endpoint + UI 編輯能力"
        />
      }
    />
  );
}
