import CrudTable from '../components/CrudTable';

const columns = [
  { title: 'ID', dataIndex: 'modbus_device_id', key: 'modbus_device_id', width: 80 },
  { title: 'UID', dataIndex: 'device_uid', key: 'device_uid' },
  { title: '設備代碼', dataIndex: 'modbus_device_code', key: 'modbus_device_code' },
  { title: '設備名稱', dataIndex: 'modbus_device_name', key: 'modbus_device_name' },
  { title: 'Slave ID', dataIndex: 'slave_id', key: 'slave_id', width: 80 },
  { title: '型號 ID', dataIndex: 'modbus_device_model_id', key: 'modbus_device_model_id', width: 100 },
  { title: '狀態', dataIndex: 'status', key: 'status', width: 80 },
];

const formFields = [
  { name: 'modbus_device_code', label: '設備代碼', type: 'text' as const, required: true },
  { name: 'modbus_device_name', label: '設備名稱', type: 'text' as const, required: true },
  { name: 'slave_id', label: 'Slave ID', type: 'number' as const },
  { name: 'hub_id', label: 'Gateway ID', type: 'number' as const },
  { name: 'modbus_device_model_id', label: '型號 ID', type: 'number' as const },
  { name: 'remark_desc', label: '備註', type: 'textarea' as const },
];

export default function ModbusDevices() {
  return <CrudTable title="Modbus 設備" apiPath="/admin/modbus-devices" columns={columns} formFields={formFields} rowKey="modbus_device_id" />;
}
