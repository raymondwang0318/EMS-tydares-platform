import CrudTable from '../components/CrudTable';

const columns = [
  { title: 'ID', dataIndex: 'hub_id', key: 'hub_id', width: 80 },
  { title: 'Gateway 代碼', dataIndex: 'hub_code', key: 'hub_code' },
  { title: 'Gateway 名稱', dataIndex: 'hub_name', key: 'hub_name' },
  { title: '型號', dataIndex: 'hub_model_name', key: 'hub_model_name' },
  { title: 'IP 位址', dataIndex: 'hub_ip', key: 'hub_ip' },
  { title: '狀態', dataIndex: 'status', key: 'status', width: 80 },
];

const formFields = [
  { name: 'hub_code', label: 'Gateway 代碼', type: 'text' as const, required: true },
  { name: 'hub_name', label: 'Gateway 名稱', type: 'text' as const, required: true },
  { name: 'hub_model_name', label: '型號', type: 'text' as const },
  { name: 'hub_ip', label: 'IP 位址', type: 'text' as const },
  { name: 'remark_desc', label: '備註', type: 'textarea' as const },
];

export default function Hubs() {
  return <CrudTable title="Edge Gateway 管理" apiPath="/admin/hubs" columns={columns} formFields={formFields} rowKey="hub_id" />;
}
