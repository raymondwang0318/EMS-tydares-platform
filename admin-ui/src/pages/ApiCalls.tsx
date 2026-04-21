import CrudTable from '../components/CrudTable';

const columns = [
  { title: 'ID', dataIndex: 'api_call_id', key: 'api_call_id', width: 80 },
  { title: 'URL', dataIndex: 'request_url', key: 'request_url' },
  { title: 'Hub ID', dataIndex: 'hub_id', key: 'hub_id', width: 80 },
  { title: '設備 ID', dataIndex: 'modbus_device_id', key: 'modbus_device_id', width: 100 },
  { title: '耗時(ms)', dataIndex: 'exec_duration_time', key: 'exec_duration_time', width: 100 },
  { title: '建立時間', dataIndex: 'created_at', key: 'created_at' },
];

const formFields = [
  { name: 'request_url', label: 'Request URL', type: 'text' as const, required: true },
  { name: 'hub_id', label: 'Hub ID', type: 'number' as const },
  { name: 'modbus_device_id', label: '設備 ID', type: 'number' as const },
  { name: 'remark_desc', label: '備註', type: 'textarea' as const },
];

export default function ApiCalls() {
  return <CrudTable title="API 呼叫紀錄" apiPath="/admin/api-calls" columns={columns} formFields={formFields} rowKey="api_call_id" />;
}
