/**
 * 用電計費單位 (ECSU) — M-PM-219 T-AdminUI-010 §二 補強版
 *
 * 既有頁面（M-P11-061 §三）原用 CrudTable；本卷重寫獨立 component 以支援：
 * - per-row API call columns（綁定數 / 即時 kW / 本月 kWh）
 * - 樹狀展開（parent_id 自參照）
 * - 編輯 dialog 對齊 schema 6 欄含 enabled toggle
 * - 刪除 Popconfirm 防誤刪 + 提示子 ECSU 處置（409 handling）
 *
 * 對接 backend M-P12-046 既有 8 endpoints（見 useEcsu.ts）
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  AutoComplete, Button, Form, Input, InputNumber, Modal, Popconfirm, Space,
  Spin, Switch, Table, Tag, Typography, message,
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, ReloadOutlined, LinkOutlined,
  FileExcelOutlined, CaretUpOutlined, CaretDownOutlined, SwapOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import {
  useEcsuList,
  useEcsuCircuits,
  useEcsuRealtime,
  useEcsuMonthly,
  useCreateEcsu,
  useUpdateEcsu,
  useDeleteEcsu,
  buildEcsuTree,
  type EcsuRow,
  type EcsuCircuitsResp,
  type EcsuRealtimeResp,
  type EcsuMonthlyResp,
  type EcsuFormBody,
} from '../hooks/useEcsu';
import { useReportExport, type ExportColumn } from '../hooks/useReportExport';

const { Title, Text } = Typography;

// Per-row stats column render（每 row 自己 fetch；react-query cache）
function CircuitsCountCell({ ecsuId }: { ecsuId: number }) {
  const { data, isLoading } = useEcsuCircuits(ecsuId);
  if (isLoading) return <Spin size="small" />;
  return <Text>{data?.count ?? '—'}</Text>;
}

function RealtimeKwCell({ ecsuId }: { ecsuId: number }) {
  const { data, isLoading } = useEcsuRealtime(ecsuId);
  if (isLoading) return <Spin size="small" />;
  const v = data?.realtime_kw;
  if (v == null) return <Text type="secondary">—</Text>;
  // 警示色：> 0 綠；< 0 橘（反向潮流）；= 0 灰
  const color = v > 0.001 ? '#4caf50' : v < -0.001 ? '#ff9800' : undefined;
  return <Text style={{ color, fontFamily: 'monospace' }}>{v.toFixed(2)}</Text>;
}

// 電壓欄（老王 2026-06-08）：快速判斷電表存活參考；多綁定取最高電壓（voltage_max；不平均）
function VoltageCell({ ecsuId }: { ecsuId: number }) {
  const { data, isLoading } = useEcsuRealtime(ecsuId);
  if (isLoading) return <Spin size="small" />;
  const v = data?.voltage_max;
  if (v == null) return <Text type="secondary">—</Text>;
  // 有電壓讀數（>50V）→ 電表在線綠；過低 → 異常橘
  const color = v > 50 ? '#4caf50' : '#ff9800';
  return <Text style={{ color, fontFamily: 'monospace' }}>{v.toFixed(0)} V</Text>;
}

function MonthlyKwhCell({ ecsuId }: { ecsuId: number }) {
  const { data, isLoading } = useEcsuMonthly(ecsuId);
  if (isLoading) return <Spin size="small" />;
  const v = data?.monthly_kwh;
  if (v == null) return <Text type="secondary">—</Text>;
  return <Text style={{ fontFamily: 'monospace' }}>{v.toFixed(1)}</Text>;
}

export default function Ecsu() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { exportToExcel, isExporting } = useReportExport();
  const { data: rows, isLoading, refetch } = useEcsuList();
  const createMut = useCreateEcsu();
  const updateMut = useUpdateEcsu();
  const deleteMut = useDeleteEcsu();

  // M-PM-238 §B: Excel 匯出甲方案
  // - 單 sheet 10 column；命名 Tydares_ECSU_列表_YYYYMMDD_HH.xlsx
  // - 重用 useReportExport hook (M-PM-173 既建 SheetJS pattern)
  // - 即時 kW / 本月 kWh / 綁定數 從 react-query cache 取（per-row cells 已 mount fetch）；無額外 API call
  // - tree flatten：用 useEcsuList 的 flat rows（非 treeData）；含全部父子節點同一層
  const handleExportExcel = () => {
    if (!rows || rows.length === 0) {
      message.warning('無資料可匯出');
      return;
    }
    interface ExportRow extends EcsuRow {
      _circuits_count: number | null;
      _voltage_max: number | null;
      _realtime_kw: number | null;
      _monthly_kwh: number | null;
    }
    // 對齊 UI 順序：M-PM-231 純 ecsu_id ASC sort（buildEcsuTree 兌現；本卷 Excel 同步）
    const sortedRows = [...rows].sort((a, b) => a.ecsu_id - b.ecsu_id);
    const enriched: ExportRow[] = sortedRows.map((r) => {
      const c = queryClient.getQueryData<EcsuCircuitsResp>(['ecsu', 'circuits', r.ecsu_id]);
      const rt = queryClient.getQueryData<EcsuRealtimeResp>(['ecsu', 'realtime', r.ecsu_id]);
      const mo = queryClient.getQueryData<EcsuMonthlyResp>(['ecsu', 'monthly', r.ecsu_id]);
      return {
        ...r,
        _circuits_count: c?.count ?? null,
        _voltage_max: rt?.voltage_max ?? null,
        _realtime_kw: rt?.realtime_kw ?? null,
        _monthly_kwh: mo?.monthly_kwh ?? null,
      };
    });
    const columns: ExportColumn<ExportRow>[] = [
      { key: 'ecsu_id', header: 'ID' },
      { key: 'ecsu_code', header: '代碼' },
      // M-PM-253 §二-3 / M-PM-255: region column 加 ECSU 列表 Excel（對齊列表 UI + 業主自填）
      { key: 'region', header: '區域', render: (r) => r.region ?? '' },
      { key: 'ecsu_name', header: '名稱' },
      { key: 'parent_id', header: '上層 ID', render: (r) => r.parent_id ?? '—' },
      { key: '_circuits_count', header: '綁定迴路數', render: (r) => r._circuits_count ?? '—' },
      {
        key: '_voltage_max',
        header: '電壓 (V)',
        render: (r) => (r._voltage_max == null ? '—' : r._voltage_max.toFixed(0)),
      },
      {
        key: '_realtime_kw',
        header: '即時 (kW)',
        render: (r) => (r._realtime_kw == null ? '—' : r._realtime_kw.toFixed(2)),
      },
      {
        key: '_monthly_kwh',
        header: '本月 (kWh)',
        render: (r) => (r._monthly_kwh == null ? '—' : r._monthly_kwh.toFixed(1)),
      },
      { key: 'display_seq', header: '顯示順序', render: (r) => r.display_seq ?? '—' },
      { key: 'enabled', header: '狀態', render: (r) => (r.enabled ? '啟用' : '停用') },
      { key: 'remark_desc', header: '備註', render: (r) => r.remark_desc ?? '' },
    ];
    // 業主 5/19 明示命名：Tydares_ECSU_列表_YYYYMMDD_HH.xlsx
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const filename = `Tydares_ECSU_列表_${yyyy}${mm}${dd}_${hh}.xlsx`;
    exportToExcel({ rows: enriched, columns, filename, sheetName: 'ECSU 列表' });
    message.success(`已匯出 ${filename}（${enriched.length} 列）`);
  };

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<EcsuRow | null>(null);
  const [form] = Form.useForm<EcsuFormBody>();

  // M-PM-272 §A: 3 欄純前端排序（代碼 / 區域 / 綁定數）— 老王 5/26 拍板純前端 sort
  type SortKey = 'ecsu_code' | 'region' | 'circuits';
  type SortDir = 'asc' | 'desc';
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  // none → asc → desc → none 三態；同時只有一欄 active
  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      if (sortDir === 'asc') {
        setSortDir('desc');
      } else {
        setSortKey(null);
        setSortDir('asc');
      }
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  // 排序 column header with ▲▼ icon
  const SortHeader = ({ label, col }: { label: string; col: SortKey }) => {
    const active = sortKey === col;
    const color = active ? '#1677ff' : '#bfbfbf';
    const icon = !active
      ? <SwapOutlined style={{ fontSize: 11, color, transform: 'rotate(90deg)' }} />
      : sortDir === 'asc'
        ? <CaretUpOutlined style={{ fontSize: 11, color }} />
        : <CaretDownOutlined style={{ fontSize: 11, color }} />;
    return (
      <span
        style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
        onClick={() => handleSort(col)}
      >
        {label} {icon}
      </span>
    );
  };

  // M-PM-272 §B: distinct region 選項（從現有 rows 取去重清單；動態更新）
  const distinctRegions = useMemo(() => {
    if (!rows) return [];
    const set = new Set(
      rows.map((r) => r.region).filter((v): v is string => !!v),
    );
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'zh-TW'));
  }, [rows]);

  // 樹狀資料（parent_id 自參照；antd Table expandable）
  const treeData = useMemo(() => buildEcsuTree(rows ?? []), [rows]);

  // M-PM-272 §A: 套用 sort（若 sortKey 為 null → 使用 buildEcsuTree 預設 code natural sort）
  const KW_REGEX_SORT = /^KW-(\d+)$/;
  const sortedTreeData = useMemo(() => {
    if (!sortKey) return treeData;

    const compareFn = (a: EcsuRow, b: EcsuRow): number => {
      let result = 0;
      if (sortKey === 'ecsu_code') {
        const aM = a.ecsu_code.match(KW_REGEX_SORT);
        const bM = b.ecsu_code.match(KW_REGEX_SORT);
        if (aM && bM) result = parseInt(aM[1], 10) - parseInt(bM[1], 10);
        else if (aM) result = -1;
        else if (bM) result = 1;
        else result = a.ecsu_code.localeCompare(b.ecsu_code);
      } else if (sortKey === 'region') {
        const ar = a.region ?? '';
        const br = b.region ?? '';
        if (!ar && br) return 1;  // null/empty 沉底
        if (ar && !br) return -1;
        result = ar.localeCompare(br, 'zh-TW');
      } else if (sortKey === 'circuits') {
        const ac =
          queryClient.getQueryData<EcsuCircuitsResp>(['ecsu', 'circuits', a.ecsu_id])?.count ?? -1;
        const bc =
          queryClient.getQueryData<EcsuCircuitsResp>(['ecsu', 'circuits', b.ecsu_id])?.count ?? -1;
        result = ac - bc;
      }
      return sortDir === 'asc' ? result : -result;
    };

    type TreeNode = EcsuRow & { children?: EcsuRow[] };
    const sortTree = (nodes: TreeNode[]): TreeNode[] =>
      [...nodes]
        .sort(compareFn)
        .map((n) => ({ ...n, children: n.children ? sortTree(n.children) : undefined }));

    return sortTree(treeData as TreeNode[]);
  }, [treeData, sortKey, sortDir, queryClient]);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({
      ecsu_code: '',
      ecsu_name: '',
      parent_id: null,
      display_seq: 1,
      enabled: true,
      remark_desc: '',
      region: '',
    });
    setModalOpen(true);
  };

  const openEdit = (row: EcsuRow) => {
    setEditing(row);
    form.resetFields();
    form.setFieldsValue({
      ecsu_code: row.ecsu_code,
      ecsu_name: row.ecsu_name,
      parent_id: row.parent_id,
      display_seq: row.display_seq,
      enabled: row.enabled,
      remark_desc: row.remark_desc ?? '',
      region: row.region ?? '',
    });
    setModalOpen(true);
  };

  const handleSubmit = async () => {
    try {
      const body = await form.validateFields();
      if (editing) {
        await updateMut.mutateAsync({ ecsu_id: editing.ecsu_id, ...body });
        message.success(`ECSU「${body.ecsu_code}」更新成功`);
      } else {
        await createMut.mutateAsync(body);
        message.success(`ECSU「${body.ecsu_code}」建立成功`);
      }
      setModalOpen(false);
      setEditing(null);
    } catch (err) {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      const detail = e?.response?.data?.detail ?? e?.message;
      if (detail) message.error(`操作失敗：${detail}`);
    }
  };

  const handleDelete = async (row: EcsuRow) => {
    try {
      await deleteMut.mutateAsync(row.ecsu_id);
      message.success(`ECSU「${row.ecsu_code}」已刪除`);
    } catch (err) {
      const e = err as { response?: { status?: number; data?: { detail?: string } } };
      const status = e?.response?.status;
      const detail = e?.response?.data?.detail;
      if (status === 409) {
        message.error(`刪除失敗：${detail ?? '此 ECSU 有子節點或綁定迴路；請先處置'}`);
      } else {
        message.error(`刪除失敗：${detail ?? '未知錯誤'}`);
      }
    }
  };

  const columns: ColumnsType<EcsuRow & { children?: EcsuRow[] }> = [
    // M-PM-248 §三-3 拍板：列表只隱藏 ID column；詳情頁 / 編輯 dialog 仍顯 ecsu_id（工程除錯用）
    // M-PM-272 §A: 代碼欄加 ▲▼ 純前端排序
    {
      title: <SortHeader label="代碼" col="ecsu_code" />,
      dataIndex: 'ecsu_code',
      key: 'ecsu_code',
      width: 140,
    },
    // M-PM-253 §二-3 / M-PM-255: 區域 region column（M-P12-061 backend ready；老王自填）
    // M-PM-272 §A: 區域欄加 ▲▼ 純前端排序（NULL 沉底）
    {
      title: <SortHeader label="區域" col="region" />,
      dataIndex: 'region',
      key: 'region',
      width: 140,
      render: (v: string | null) => v || <Text type="secondary">—</Text>,
    },
    { title: '名稱', dataIndex: 'ecsu_name', key: 'ecsu_name' },
    {
      title: '上層 ID',
      dataIndex: 'parent_id',
      key: 'parent_id',
      width: 80,
      render: (v: number | null) => (v ?? <Text type="secondary">—</Text>),
    },
    {
      // M-PM-272 §A: 綁定數欄加 ▲▼ 純前端排序（從 react-query cache 取 count）
      title: <SortHeader label="綁定數" col="circuits" />,
      key: 'circuits_count',
      width: 90,
      align: 'right',
      render: (_: unknown, row) => <CircuitsCountCell ecsuId={row.ecsu_id} />,
    },
    {
      // 電壓欄（老王 2026-06-08）：快速判斷電表存活參考；多綁定取最高電壓（不平均）
      title: '電壓 (V)',
      key: 'voltage_max',
      width: 90,
      align: 'right',
      render: (_: unknown, row) => <VoltageCell ecsuId={row.ecsu_id} />,
    },
    {
      title: '即時 (kW)',
      key: 'realtime_kw',
      width: 100,
      align: 'right',
      render: (_: unknown, row) => <RealtimeKwCell ecsuId={row.ecsu_id} />,
    },
    {
      title: '本月 (kWh)',
      key: 'monthly_kwh',
      width: 110,
      align: 'right',
      render: (_: unknown, row) => <MonthlyKwhCell ecsuId={row.ecsu_id} />,
    },
    { title: '顯示順序', dataIndex: 'display_seq', key: 'display_seq', width: 90, align: 'right' },
    {
      title: '狀態',
      dataIndex: 'enabled',
      key: 'enabled',
      width: 80,
      render: (v: boolean) =>
        v ? <Tag color="green">啟用</Tag> : <Tag color="default">停用</Tag>,
    },
    {
      title: '操作',
      key: 'action',
      width: 200,
      render: (_: unknown, row) => (
        <Space size={4}>
          {/* M-PM-220 §三：詳情頁入口 */}
          <Button
            size="small"
            type="link"
            icon={<LinkOutlined />}
            onClick={() => navigate(`/ecsu/${row.ecsu_id}`)}
          >
            綁定
          </Button>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)}>
            編輯
          </Button>
          <Popconfirm
            title={`刪除 ECSU「${row.ecsu_code}」？`}
            description="若有子節點 / 綁定迴路將回 409 提示處置。"
            okText="確認刪除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={() => handleDelete(row)}
          >
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Title level={3} style={{ marginTop: 0 }}>用電計費單位 (ECSU)</Title>
      <Space style={{ marginBottom: 16 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          新增 ECSU
        </Button>
        <Button icon={<ReloadOutlined />} onClick={() => refetch()}>
          重新整理
        </Button>
        {/* M-PM-238 §B：Excel 匯出甲方案；單 sheet 10 column；命名 Tydares_ECSU_列表_YYYYMMDD_HH.xlsx */}
        <Button
          icon={<FileExcelOutlined />}
          onClick={handleExportExcel}
          loading={isExporting}
          disabled={!rows || rows.length === 0}
        >
          匯出 Excel
        </Button>
        <Text type="secondary" style={{ fontSize: 12 }}>
          M-PM-219 §二補強：含綁定迴路數 / 即時 kW（30s 自動更新）/ 本月累積 kWh
        </Text>
      </Space>

      <Table<EcsuRow & { children?: EcsuRow[] }>
        rowKey="ecsu_id"
        columns={columns}
        dataSource={sortedTreeData as (EcsuRow & { children?: EcsuRow[] })[]}
        loading={isLoading}
        size="small"
        pagination={false}
        expandable={{ defaultExpandAllRows: true }}
      />

      <Modal
        title={editing ? `編輯 ECSU - ${editing.ecsu_code}` : '新增 ECSU'}
        open={modalOpen}
        onCancel={() => {
          setModalOpen(false);
          setEditing(null);
        }}
        onOk={handleSubmit}
        confirmLoading={createMut.isPending || updateMut.isPending}
        destroyOnHidden
        width={520}
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item
            name="ecsu_code"
            label="代碼"
            extra="格式：KW-\d+（如 KW-01 / KW-21；不限位數；natural sort 不依賴補零）"
            rules={[
              { required: true, message: '代碼必填' },
              // M-PM-248 §三-2 拍板：代碼規則 KW-\d+；client-side 校驗
              {
                pattern: /^KW-\d+$/,
                message: '代碼必須符合格式 KW-\\d+（例：KW-01 / KW-21）',
              },
            ]}
          >
            <Input placeholder="例：KW-01" disabled={!!editing} />
          </Form.Item>
          <Form.Item
            name="ecsu_name"
            label="名稱"
            rules={[{ required: true, message: '名稱必填' }]}
          >
            <Input placeholder="例：農技大樓總幹線" />
          </Form.Item>
          {/* M-PM-253 §二-2 / M-PM-255: 區域 region 欄位（M-P12-061 backend ready；業主自填）*/}
          {/* M-PM-272 §B: 改 AutoComplete — 下拉顯示現有區域選項 + 支援自由輸入新值；可留空 */}
          <Form.Item name="region" label="區域" extra="選擇已有區域或輸入新區域；可留空">
            <AutoComplete
              options={distinctRegions.map((r) => ({ value: r }))}
              placeholder="例：育成 Aa 區 / C 區"
              allowClear
              maxLength={50}
              filterOption={(inputValue, option) =>
                option?.value?.toLowerCase().includes(inputValue.toLowerCase()) ?? false
              }
            />
          </Form.Item>
          <Form.Item name="parent_id" label="上層 ID（選填；樹狀層級）">
            <InputNumber style={{ width: '100%' }} placeholder="若為根節點留空" />
          </Form.Item>
          <Form.Item name="display_seq" label="顯示順序">
            <InputNumber style={{ width: '100%' }} min={1} />
          </Form.Item>
          <Form.Item name="enabled" label="啟用" valuePropName="checked">
            <Switch checkedChildren="啟用" unCheckedChildren="停用" />
          </Form.Item>
          <Form.Item name="remark_desc" label="備註">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
