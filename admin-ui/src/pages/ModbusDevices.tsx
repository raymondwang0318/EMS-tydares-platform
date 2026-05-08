import { useMemo, useState } from 'react';
import { Alert, Select, Space, Tag, Typography } from 'antd';
import CrudTable from '../components/CrudTable';
import { useEdges } from '../hooks/useEdges';

const { Text } = Typography;

/**
 * Modbus 設備管理（全站唯讀總覽）
 *
 * T-P11-003 對齊 V2-final `/v1/admin/devices` schema（ADR-026 ems_device 結構）。
 * 老王 2026-04-23 裁決（選項 A）：新增走 Edge → Wizard（hideAdd）；本頁僅唯讀 + 改 display_name。
 *
 * M-PM-176 / T-AdminUI-004（老王 5/8 15:30 chat）：
 *   - 「所屬 Edge」改第 1 欄（業務直覺：先看歸屬再看細節）
 *   - 表格上方加 Edge filter 下拉（顯示全部 / 單一 Edge）
 *   - fleet 5 顆 Edge × ~10 設備管理需要 filter
 */

// M-PM-176 column 重排：所屬 Edge 改第 1 欄
const columns = [
  { title: '所屬 Edge', dataIndex: 'edge_id', key: 'edge_id', width: 160 },
  { title: '設備 ID', dataIndex: 'device_id', key: 'device_id' },
  { title: '類別', dataIndex: 'device_kind', key: 'device_kind', width: 120 },
  { title: '顯示名稱', dataIndex: 'display_name', key: 'display_name' },
  { title: '型號 ID', dataIndex: 'model_id', key: 'model_id', width: 100, render: (v: number | null) => (v ?? '—') },
  { title: 'Config Ver', dataIndex: 'config_version', key: 'config_version', width: 100 },
  {
    title: '狀態',
    dataIndex: 'enabled',
    key: 'enabled',
    width: 80,
    render: (v: boolean) => (v ? '啟用' : '停用'),
  },
];

// 編輯欄位只留 display_name
const formFields = [
  { name: 'display_name', label: '顯示名稱', type: 'text' as const, required: true },
];

const FILTER_ALL = '__ALL__';

export default function ModbusDevices() {
  // M-PM-176 / T-AdminUI-004：Edge filter 下拉
  const [filterEdgeId, setFilterEdgeId] = useState<string>(FILTER_ALL);
  const { data: edgesData } = useEdges();

  const edgeOptions = useMemo(() => {
    const opts: { value: string; label: React.ReactNode }[] = [
      { value: FILTER_ALL, label: '顯示全部' },
    ];
    (edgesData ?? []).forEach((e) => {
      const status = e.status;
      const isInactive = status === 'revoked' || status === 'pending';
      opts.push({
        value: e.edge_id,
        label: (
          <Space size={4}>
            <span>{e.edge_id}</span>
            {e.edge_name && e.edge_name !== e.edge_id && (
              <Text type="secondary" style={{ fontSize: 11 }}>· {e.edge_name}</Text>
            )}
            {isInactive && (
              <Tag color="default" style={{ marginRight: 0, fontSize: 10 }}>{status}</Tag>
            )}
          </Space>
        ),
      });
    });
    return opts;
  }, [edgesData]);

  const filterFn = useMemo(
    () => (filterEdgeId === FILTER_ALL
      ? undefined
      : (row: { edge_id?: string }) => row.edge_id === filterEdgeId),
    [filterEdgeId],
  );

  const toolbarExtra = (
    <Space size={8} wrap>
      <Text type="secondary" style={{ fontSize: 12 }}>所屬 Edge：</Text>
      <Select
        style={{ minWidth: 220 }}
        value={filterEdgeId}
        onChange={setFilterEdgeId}
        options={edgeOptions}
        size="middle"
        showSearch
        optionFilterProp="value"
      />
    </Space>
  );

  return (
    <CrudTable
      title="Modbus 設備"
      apiPath="/admin/devices"
      columns={columns}
      formFields={formFields}
      rowKey="device_id"
      hideAdd
      hideDelete
      toolbarExtra={toolbarExtra}
      filterFn={filterFn}
      hintText={
        <Alert
          type="info"
          showIcon
          message="新增 Modbus 設備請走 Edge 管理頁 → 選 Edge → 點「掃描設備」Wizard"
          description="本頁為全站設備唯讀總覽；手動編輯限制在「顯示名稱」（其他識別性欄位由 Wizard 掃描匯入決定，避免 dirty data）。所屬 Edge filter 可篩選單一 Edge 設備。"
        />
      }
    />
  );
}
