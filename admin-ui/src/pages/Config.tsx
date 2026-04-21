import CrudTable from '../components/CrudTable';

const columns = [
  { title: 'ID', dataIndex: 'config_id', key: 'config_id', width: 80 },
  { title: '設定代碼', dataIndex: 'config_code', key: 'config_code' },
  { title: '設定名稱', dataIndex: 'config_name', key: 'config_name' },
  { title: '網域/IP', dataIndex: 'domain_name_or_ip_address', key: 'domain_name_or_ip_address' },
  { title: 'Port', dataIndex: 'port_number', key: 'port_number', width: 80 },
  { title: 'Callback IP', dataIndex: 'callback_server_domain_ip', key: 'callback_server_domain_ip' },
];

const formFields = [
  { name: 'config_code', label: '設定代碼', type: 'text' as const, required: true },
  { name: 'config_name', label: '設定名稱', type: 'text' as const, required: true },
  { name: 'domain_name_or_ip_address', label: '網域/IP', type: 'text' as const },
  { name: 'port_number', label: 'Port', type: 'number' as const },
  { name: 'callback_server_domain_ip', label: 'Callback IP', type: 'text' as const },
  { name: 'callback_server_port', label: 'Callback Port', type: 'number' as const },
  { name: 'remark_desc', label: '備註', type: 'textarea' as const },
];

export default function Config() {
  return <CrudTable title="系統設定" apiPath="/admin/configs" columns={columns} formFields={formFields} rowKey="config_id" />;
}
