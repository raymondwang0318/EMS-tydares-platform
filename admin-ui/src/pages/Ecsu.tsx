import CrudTable from '../components/CrudTable';

/**
 * 用電計費單位 (ECSU)
 *
 * T-P11-003 對齊 V2-final `/v1/admin/ecsu` schema（v1_admin.py list_ecsu）：
 * - V2 keys: ecsu_id / ecsu_code（單一 code，不再 code_1/2/3 三層）
 *            / ecsu_name / parent_id / display_seq / enabled
 * - POST body: ecsu_code / ecsu_name / parent_id / display_seq / enabled / remark_desc
 * - 結果：cells 不再空白（M-PM-061 §3.2 demo polish）
 */

const columns = [
  { title: 'ID', dataIndex: 'ecsu_id', key: 'ecsu_id', width: 80 },
  { title: '代碼', dataIndex: 'ecsu_code', key: 'ecsu_code', width: 160 },
  { title: '名稱', dataIndex: 'ecsu_name', key: 'ecsu_name' },
  { title: '上層 ID', dataIndex: 'parent_id', key: 'parent_id', width: 100, render: (v: number | null) => (v ?? '—') },
  { title: '顯示順序', dataIndex: 'display_seq', key: 'display_seq', width: 100 },
  {
    title: '狀態',
    dataIndex: 'enabled',
    key: 'enabled',
    width: 80,
    render: (v: boolean) => (v ? '啟用' : '停用'),
  },
];

const formFields = [
  { name: 'ecsu_code', label: '代碼', type: 'text' as const, required: true },
  { name: 'ecsu_name', label: '名稱', type: 'text' as const, required: true },
  { name: 'parent_id', label: '上層 ID（選填）', type: 'number' as const },
  { name: 'display_seq', label: '顯示順序', type: 'number' as const },
  { name: 'remark_desc', label: '備註', type: 'textarea' as const },
];

export default function Ecsu() {
  return (
    <CrudTable
      title="用電計費單位 (ECSU)"
      apiPath="/admin/ecsu"
      columns={columns}
      formFields={formFields}
      rowKey="ecsu_id"
    />
  );
}
