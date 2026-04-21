import CrudTable from '../components/CrudTable';

const columns = [
  { title: 'ID', dataIndex: 'electric_parameter_id', key: 'electric_parameter_id', width: 80 },
  { title: '參數代碼', dataIndex: 'electric_parameter_code', key: 'electric_parameter_code' },
  { title: '參數名稱', dataIndex: 'electric_parameter_name', key: 'electric_parameter_name' },
  { title: '單位', dataIndex: 'uom_name', key: 'uom_name', width: 80 },
  { title: '資料型別', dataIndex: 'data_type', key: 'data_type', width: 100 },
  { title: '小數位', dataIndex: 'decimal_place', key: 'decimal_place', width: 80 },
  { title: '分類', dataIndex: 'parameter_category', key: 'parameter_category' },
];

const formFields = [
  { name: 'electric_parameter_code', label: '參數代碼', type: 'text' as const, required: true },
  { name: 'electric_parameter_name', label: '參數名稱', type: 'text' as const, required: true },
  { name: 'uom_name', label: '單位', type: 'text' as const },
  { name: 'data_type', label: '資料型別', type: 'text' as const },
  { name: 'decimal_place', label: '小數位', type: 'number' as const },
  { name: 'function_code', label: 'Function Code', type: 'text' as const },
  { name: 'parameter_category', label: '分類', type: 'text' as const },
  { name: 'display_seq', label: '顯示順序', type: 'number' as const },
];

export default function ElectricParams() {
  return <CrudTable title="電力參數" apiPath="/admin/electric-params" columns={columns} formFields={formFields} rowKey="electric_parameter_id" />;
}
