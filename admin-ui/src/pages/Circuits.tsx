import CrudTable from '../components/CrudTable';

const columns = [
  { title: 'ID', dataIndex: 'modbus_device_circuit_id', key: 'modbus_device_circuit_id', width: 80 },
  { title: '設備 ID', dataIndex: 'modbus_device_id', key: 'modbus_device_id', width: 100 },
  { title: '型號迴路 ID', dataIndex: 'modbus_device_model_circuit_id', key: 'modbus_device_model_circuit_id', width: 120 },
  { title: '顯示順序', dataIndex: 'display_seq', key: 'display_seq', width: 100 },
  { title: '開關狀態', dataIndex: 'on_off_status', key: 'on_off_status', width: 100 },
];

const formFields = [
  { name: 'modbus_device_id', label: '設備 ID', type: 'number' as const, required: true },
  { name: 'modbus_device_model_circuit_id', label: '型號迴路 ID', type: 'number' as const, required: true },
  { name: 'display_seq', label: '顯示順序', type: 'number' as const },
  { name: 'on_off_status', label: '開關狀態', type: 'text' as const },
];

export default function Circuits() {
  return <CrudTable title="迴路管理" apiPath="/admin/circuits" columns={columns} formFields={formFields} rowKey="modbus_device_circuit_id" />;
}
