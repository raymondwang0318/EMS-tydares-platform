import CrudTable from '../components/CrudTable';

const columns = [
  { title: 'ID', dataIndex: 'modbus_device_model_id', key: 'modbus_device_model_id', width: 80 },
  { title: '型號代碼', dataIndex: 'modbus_device_model_code', key: 'modbus_device_model_code' },
  { title: '型號名稱', dataIndex: 'modbus_device_model_name', key: 'modbus_device_model_name' },
  { title: '類型', dataIndex: 'modbus_device_model_type', key: 'modbus_device_model_type' },
  { title: '預設 Slave ID', dataIndex: 'slave_id_default', key: 'slave_id_default', width: 120 },
];

const formFields = [
  { name: 'modbus_device_model_code', label: '型號代碼', type: 'text' as const, required: true },
  { name: 'modbus_device_model_name', label: '型號名稱', type: 'text' as const, required: true },
  { name: 'modbus_device_model_type', label: '類型', type: 'text' as const },
  { name: 'slave_id_default', label: '預設 Slave ID', type: 'number' as const },
  { name: 'remark_desc', label: '備註', type: 'textarea' as const },
];

export default function ModbusModels() {
  // V2-final endpoint 對齊：/admin/modbus-models → /admin/device-models（baseURL /v1）
  return <CrudTable title="設備型號" apiPath="/admin/device-models" columns={columns} formFields={formFields} rowKey="modbus_device_model_id" />;
}
