import CrudTable from '../components/CrudTable';

const columns = [
  { title: 'ID', dataIndex: 'meter_id', key: 'meter_id', width: 80 },
  { title: 'UID', dataIndex: 'meter_uid', key: 'meter_uid' },
  { title: '電表代碼', dataIndex: 'meter_code', key: 'meter_code' },
  { title: '電表名稱', dataIndex: 'meter_name', key: 'meter_name' },
  { title: '設備類型', dataIndex: 'device_type', key: 'device_type' },
  { title: 'Gateway ID', dataIndex: 'hub_id', key: 'hub_id', width: 100 },
];

const formFields = [
  { name: 'meter_code', label: '電表代碼', type: 'text' as const, required: true },
  { name: 'meter_name', label: '電表名稱', type: 'text' as const, required: true },
  { name: 'device_type', label: '設備類型', type: 'text' as const },
  { name: 'hub_id', label: 'Gateway ID', type: 'number' as const },
  { name: 'remark_desc', label: '備註', type: 'textarea' as const },
];

export default function Meters() {
  return <CrudTable title="電表管理" apiPath="/admin/meters" columns={columns} formFields={formFields} rowKey="meter_id" />;
}
