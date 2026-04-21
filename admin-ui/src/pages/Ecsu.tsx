import CrudTable from '../components/CrudTable';

const columns = [
  { title: 'ID', dataIndex: 'ecsu_id', key: 'ecsu_id', width: 80 },
  { title: '棟別', dataIndex: 'ecsu_code_1', key: 'ecsu_code_1' },
  { title: '樓層', dataIndex: 'ecsu_code_2', key: 'ecsu_code_2' },
  { title: '空間', dataIndex: 'ecsu_code_3', key: 'ecsu_code_3' },
  { title: '名稱', dataIndex: 'ecsu_name', key: 'ecsu_name' },
  { title: '電壓', dataIndex: 'voltage', key: 'voltage', width: 80 },
  { title: '功率因數', dataIndex: 'power_factor', key: 'power_factor', width: 100 },
  { title: '狀態', dataIndex: 'status', key: 'status', width: 80 },
];

const formFields = [
  { name: 'ecsu_code_1', label: '棟別 (code_1)', type: 'text' as const, required: true },
  { name: 'ecsu_code_2', label: '樓層 (code_2)', type: 'text' as const },
  { name: 'ecsu_code_3', label: '空間 (code_3)', type: 'text' as const },
  { name: 'ecsu_name', label: '名稱', type: 'text' as const, required: true },
  { name: 'display_seq', label: '顯示順序', type: 'number' as const },
  { name: 'remark_desc', label: '備註', type: 'textarea' as const },
];

export default function Ecsu() {
  return <CrudTable title="用電計費單位 (ECSU)" apiPath="/admin/ecsu" columns={columns} formFields={formFields} rowKey="ecsu_id" />;
}
