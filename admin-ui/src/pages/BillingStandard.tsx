import CrudTable from '../components/CrudTable';

const columns = [
  { title: 'ID', dataIndex: 'elec_billing_standard_id', key: 'elec_billing_standard_id', width: 80 },
  { title: '星期', dataIndex: 'week_day', key: 'week_day', width: 80 },
  { title: '時段類型', dataIndex: 'period_type', key: 'period_type' },
  { title: '夏月', dataIndex: 'summer_time_yn', key: 'summer_time_yn', width: 80 },
  { title: '開始時間', dataIndex: 'period_start_time', key: 'period_start_time', width: 100 },
  { title: '結束時間', dataIndex: 'period_end_time', key: 'period_end_time', width: 100 },
  { title: '單價', dataIndex: 'unit_price', key: 'unit_price', width: 100 },
  { title: '顏色', dataIndex: 'color_setting', key: 'color_setting', width: 100 },
];

const formFields = [
  { name: 'week_day', label: '星期 (MON/TUE/...)', type: 'text' as const, required: true },
  { name: 'period_type', label: '時段類型 (尖峰/半尖峰/離峰)', type: 'text' as const, required: true },
  { name: 'summer_time_yn', label: '夏月 (true/false)', type: 'text' as const },
  { name: 'period_start_time', label: '開始時間 (HHMM)', type: 'text' as const },
  { name: 'period_end_time', label: '結束時間 (HHMM)', type: 'text' as const },
  { name: 'unit_price', label: '單價', type: 'number' as const },
  { name: 'color_setting', label: '顏色代碼', type: 'text' as const },
  { name: 'remark_desc', label: '備註', type: 'textarea' as const },
];

export default function BillingStandard() {
  return <CrudTable title="電價標準" apiPath="/admin/billing-standard" columns={columns} formFields={formFields} rowKey="elec_billing_standard_id" />;
}
