import { useEffect, useMemo, useState } from 'react';
import { Table, Typography, Space, Button, Modal, Input, App, Tooltip, Alert, Badge, Tag } from 'antd';
import { ReloadOutlined, CheckOutlined, StopOutlined, ToolOutlined, PlayCircleOutlined, SyncOutlined, ScanOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { StatusTag } from '../components/common/StatusTag';
import {
  useEdges,
  useApproveEdge,
  useRevokeEdge,
  useMaintenanceEdge,
  useResumeEdge,
  useResyncEdge,
  type Edge,
} from '../hooks/useEdges';
import {
  useEdgeDevices,
  useRenameDevice,
  useRenameEdgeHostname,
  type EmsDevice,
} from '../hooks/useScanWizard';
import { EdgeDrawer } from './EdgeDrawer';
import { ScanWizard } from '../components/ScanWizard';

const { Title, Text } = Typography;

function shortFp(fp: string | null): string {
  if (!fp) return '—';
  return fp.length > 16 ? fp.slice(0, 16) + '…' : fp;
}

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function Edges() {
  const { data: edges, isLoading, isFetching, refetch, error } = useEdges();
  const { message, modal } = App.useApp();

  // M-PM-123 §3.5 通用 loading-timeout fallback：保證最壞 ~15 sec 顯示 timeout UI 而非永久 hang
  // 對齊老王 2026-05-06 chat 「載入中 >10 min」regression；無論 axios timeout / react-query retry / Tailscale 路由
  // 何種根因，都不會讓使用者卡 loading state >15 sec
  const [loadingStuck, setLoadingStuck] = useState(false);
  useEffect(() => {
    if (!isLoading) {
      setLoadingStuck(false);
      return;
    }
    const t = setTimeout(() => setLoadingStuck(true), 15_000);
    return () => clearTimeout(t);
  }, [isLoading]);

  const approve = useApproveEdge();
  const revoke = useRevokeEdge();
  const maintenance = useMaintenanceEdge();
  const resume = useResumeEdge();
  const resync = useResyncEdge();

  const [revokeTarget, setRevokeTarget] = useState<Edge | null>(null);
  const [revokeReason, setRevokeReason] = useState('');
  const [drawerEdge, setDrawerEdge] = useState<Edge | null>(null);
  const [scanEdgeId, setScanEdgeId] = useState<string | null>(null);

  const renameHostname = useRenameEdgeHostname();

  const pendingCount = useMemo(
    () => (edges ?? []).filter((e) => e.status === 'pending' || e.status === 'pending_replace').length,
    [edges],
  );

  const handleApprove = (edge: Edge) => {
    const isReplace = edge.status === 'pending_replace';
    modal.confirm({
      title: isReplace ? '核可換機' : '核可 Edge',
      content: isReplace ? (
        <div>
          <p>Edge 送來的硬體指紋與舊紀錄不符，核可表示接受此為同一台 Edge 的新硬體。</p>
          <p style={{ marginBottom: 0 }}>
            <Text type="secondary">當前指紋：{shortFp(edge.fingerprint)}</Text>
          </p>
        </div>
      ) : (
        <p>核可後 Edge 會拿到新 token，進入 approved 狀態。</p>
      ),
      okText: isReplace ? '確認為同一台 Edge' : '核可',
      cancelText: '取消',
      onOk: async () => {
        try {
          await approve.mutateAsync(edge.edge_id);
          message.success(`${edge.edge_id} 已核可`);
        } catch (e) {
          message.error(`核可失敗：${(e as Error).message}`);
        }
      },
    });
  };

  const handleMaintenance = (edge: Edge) => {
    modal.confirm({
      title: '切入維護模式',
      content: `${edge.edge_id} 將進入 maintenance 狀態，Edge 的 heartbeat 仍會接受但不觸發告警。`,
      okText: '切換',
      cancelText: '取消',
      onOk: async () => {
        try {
          await maintenance.mutateAsync(edge.edge_id);
          message.success(`${edge.edge_id} 進入維護`);
        } catch (e) {
          message.error(`切換失敗：${(e as Error).message}`);
        }
      },
    });
  };

  const handleResume = (edge: Edge) => {
    modal.confirm({
      title: '結束維護',
      content: `${edge.edge_id} 將從 maintenance 恢復為 approved。`,
      okText: '恢復',
      cancelText: '取消',
      onOk: async () => {
        try {
          await resume.mutateAsync(edge.edge_id);
          message.success(`${edge.edge_id} 已恢復`);
        } catch (e) {
          message.error(`恢復失敗：${(e as Error).message}`);
        }
      },
    });
  };

  const handleResync = async (edge: Edge) => {
    try {
      const r = await resync.mutateAsync(edge.edge_id);
      message.success(`${edge.edge_id} config_version 已升至 ${r.new_version}，下次 Edge 拉取會套用`);
    } catch (e) {
      message.error(`觸發失敗：${(e as Error).message}`);
    }
  };

  const openRevokeModal = (edge: Edge) => {
    setRevokeTarget(edge);
    setRevokeReason('');
  };

  const submitRevoke = async () => {
    if (!revokeTarget) return;
    try {
      await revoke.mutateAsync({ edgeId: revokeTarget.edge_id, reason: revokeReason });
      message.success(`${revokeTarget.edge_id} 已撤銷`);
      setRevokeTarget(null);
    } catch (e) {
      message.error(`撤銷失敗：${(e as Error).message}`);
    }
  };

  const columns: ColumnsType<Edge> = [
    {
      title: 'Edge ID',
      dataIndex: 'edge_id',
      key: 'edge_id',
      width: 180,
      fixed: 'left',
      render: (id: string, record) => (
        <Button type="link" onClick={() => setDrawerEdge(record)} style={{ padding: 0, height: 'auto' }}>
          {id}
        </Button>
      ),
    },
    { title: '名稱', dataIndex: 'edge_name', key: 'edge_name', width: 160, render: (v) => v ?? '—' },
    {
      title: '狀態',
      dataIndex: 'status',
      key: 'status',
      width: 120,
      render: (status: Edge['status']) => <StatusTag status={status} />,
      filters: [
        { text: '待核可', value: 'pending' },
        { text: '已核可', value: 'approved' },
        { text: '維護中', value: 'maintenance' },
        { text: '待核可換機', value: 'pending_replace' },
        { text: '已撤銷', value: 'revoked' },
      ],
      onFilter: (value, record) => record.status === value,
    },
    {
      title: '主機名',
      dataIndex: 'hostname',
      key: 'hostname',
      width: 180,
      render: (v: string | null, record) => (
        <Text
          editable={{
            tooltip: '點擊編輯主機名稱',
            onChange: async (val: string) => {
              const next = val.trim();
              if (!next || next === (v ?? '')) return;
              try {
                await renameHostname.mutateAsync({ edgeId: record.edge_id, hostname: next });
                message.success('主機名稱已更新');
              } catch (e) {
                message.error(`更新主機名稱失敗：${(e as Error).message}`);
              }
            },
          }}
        >
          {v ?? '—'}
        </Text>
      ),
    },
    {
      title: '指紋 (前 16)',
      dataIndex: 'fingerprint',
      key: 'fingerprint',
      width: 180,
      render: (fp: string | null) => (
        <Tooltip title={fp ?? '尚未 enroll'}>
          <Text code style={{ fontSize: 12 }}>{shortFp(fp)}</Text>
        </Tooltip>
      ),
    },
    {
      title: 'config_version',
      dataIndex: 'config_version',
      key: 'config_version',
      width: 130,
      align: 'right',
      render: (v: number) => <Badge count={v} showZero color="#1677ff" overflowCount={9999} />,
    },
    {
      title: '最近上線',
      dataIndex: 'last_seen_at',
      key: 'last_seen_at',
      width: 160,
      render: (iso: string | null) => formatTime(iso),
      sorter: (a, b) => (a.last_seen_at ?? '').localeCompare(b.last_seen_at ?? ''),
    },
    {
      title: '操作',
      key: 'actions',
      fixed: 'right',
      width: 340,
      render: (_, edge) => {
        const canApprove = edge.status === 'pending' || edge.status === 'pending_replace';
        const canRevoke = edge.status === 'approved' || edge.status === 'maintenance';
        const canMaintenance = edge.status === 'approved';
        const canResume = edge.status === 'maintenance';
        const canResync = edge.status === 'approved' || edge.status === 'maintenance';
        const canScan = edge.status === 'approved' || edge.status === 'maintenance';
        return (
          <Space wrap size={4}>
            {canApprove && (
              <Button
                size="small"
                type="primary"
                icon={<CheckOutlined />}
                onClick={() => handleApprove(edge)}
                loading={approve.isPending}
              >
                {edge.status === 'pending_replace' ? '核可換機' : '核可'}
              </Button>
            )}
            {canScan && (
              <Button
                size="small"
                icon={<ScanOutlined />}
                onClick={() => setScanEdgeId(edge.edge_id)}
              >
                掃描設備
              </Button>
            )}
            {canMaintenance && (
              <Button size="small" icon={<ToolOutlined />} onClick={() => handleMaintenance(edge)} loading={maintenance.isPending}>
                維護
              </Button>
            )}
            {canResume && (
              <Button size="small" icon={<PlayCircleOutlined />} onClick={() => handleResume(edge)} loading={resume.isPending}>
                恢復
              </Button>
            )}
            {canResync && (
              <Tooltip title="Bump config_version，下次 Edge heartbeat 會重拉">
                <Button size="small" icon={<SyncOutlined />} onClick={() => handleResync(edge)} loading={resync.isPending}>
                  重拉 config
                </Button>
              </Tooltip>
            )}
            {canRevoke && (
              <Button size="small" danger icon={<StopOutlined />} onClick={() => openRevokeModal(edge)} loading={revoke.isPending}>
                撤銷
              </Button>
            )}
          </Space>
        );
      },
    },
  ];

  return (
    <div>
      <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 16 }} align="start">
        <div>
          <Title level={3} style={{ margin: 0 }}>Edge 管理</Title>
          <Text type="secondary">核可、撤銷、維護、指紋漂移流程及 config 同步狀態</Text>
        </div>
        <Button icon={<ReloadOutlined />} loading={isFetching} onClick={() => refetch()}>
          重新整理
        </Button>
      </Space>

      {pendingCount > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={`有 ${pendingCount} 台 Edge 等待核可`}
          description="pending / pending_replace 狀態的 Edge 需要人工核可後才能上線。"
        />
      )}

      {error && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message="讀取 Edge 列表失敗"
          description={(error as Error).message}
          action={
            <Button size="small" icon={<ReloadOutlined />} onClick={() => refetch()}>
              重試
            </Button>
          }
        />
      )}

      {loadingStuck && (
        // M-PM-123 §3.5 loading timeout fallback — 15s 仍 isLoading 即顯重試 UI
        // 真正根因如 backend hang / Tailscale 斷 / nginx 反代 buffer 卡 → 老王 F12 console 看 [useEdges] err log
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="載入時間超過 15 秒"
          description="後端 /v1/admin/edges 回應比預期慢；可能網路 / Tailscale / 反代問題；F12 Console 可看 [useEdges] 錯誤詳情。點「重試」重新載入；或檢查 Edge 主機網路是否暢通。"
          action={
            <Button size="small" type="primary" icon={<ReloadOutlined />} onClick={() => refetch()}>
              重試
            </Button>
          }
        />
      )}

      <Table
        rowKey="edge_id"
        loading={isLoading}
        dataSource={edges ?? []}
        columns={columns}
        pagination={{ pageSize: 20, showSizeChanger: true }}
        scroll={{ x: 1200 }}
        size="middle"
        expandable={{
          expandedRowRender: (record) => <EdgeDevicesTable edgeId={record.edge_id} />,
          rowExpandable: (record) => record.status !== 'revoked',
        }}
      />

      <ScanWizard
        edgeId={scanEdgeId}
        open={!!scanEdgeId}
        onClose={() => setScanEdgeId(null)}
      />

      <Modal
        title={`撤銷 Edge：${revokeTarget?.edge_id ?? ''}`}
        open={!!revokeTarget}
        onOk={submitRevoke}
        onCancel={() => setRevokeTarget(null)}
        okText="確認撤銷"
        okButtonProps={{ danger: true, loading: revoke.isPending }}
        cancelText="取消"
      >
        <p>撤銷後該 Edge 需重新 enroll 才能再上線。</p>
        <Input.TextArea
          rows={3}
          placeholder="撤銷原因（選填）"
          value={revokeReason}
          onChange={(e) => setRevokeReason(e.target.value)}
        />
      </Modal>

      <EdgeDrawer edge={drawerEdge} open={!!drawerEdge} onClose={() => setDrawerEdge(null)} />
    </div>
  );
}

function EdgeDevicesTable({ edgeId }: { edgeId: string }) {
  const { data: devices, isLoading, error, refetch } = useEdgeDevices(edgeId);
  const renameDevice = useRenameDevice();
  const { message } = App.useApp();

  // M-PM-123 補修：子表 loadingStuck fallback（10s 超時）— 同 useEdges loadingStuck pattern
  // 對齊老王 2026-05-06 chat 「展開 + 按鈕後子表載入中 >1 min」regression
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    if (!isLoading) {
      setStuck(false);
      return;
    }
    const t = setTimeout(() => setStuck(true), 10_000);
    return () => clearTimeout(t);
  }, [isLoading]);

  if (isLoading && stuck) {
    return (
      <Alert
        type="warning"
        showIcon
        message={`Edge ${edgeId} 設備清單載入超過 10 秒`}
        description="可能網路 / Tailscale / 反代問題；F12 Console 看 [useEdgeDevices] 錯誤詳情。"
        action={
          <Button size="small" type="primary" icon={<ReloadOutlined />} onClick={() => refetch()}>
            重試
          </Button>
        }
      />
    );
  }
  if (isLoading) return <Text type="secondary">載入中...</Text>;
  if (error) {
    return (
      <Alert
        type="error"
        showIcon
        message={`Edge ${edgeId} 設備清單載入失敗`}
        description={(error as Error).message}
        action={
          <Button size="small" icon={<ReloadOutlined />} onClick={() => refetch()}>
            重試
          </Button>
        }
      />
    );
  }

  const rows = (devices ?? []).filter((d) => d.device_type !== '_placeholder');
  if (rows.length === 0) return <Text type="secondary">尚無已註冊設備</Text>;

  const columns: ColumnsType<EmsDevice> = [
    { title: 'Device ID', dataIndex: 'device_id', key: 'device_id', width: 260 },
    {
      title: '名稱',
      dataIndex: 'device_name',
      key: 'name',
      render: (v: string | null, row: EmsDevice) => (
        <Text
          editable={{
            tooltip: '點擊編輯設備名稱',
            onChange: async (val: string) => {
              const next = val.trim();
              if (!next || next === (v ?? '')) return;
              try {
                await renameDevice.mutateAsync({
                  deviceId: row.device_id,
                  deviceName: next,
                  edgeId,
                });
                message.success('設備名稱已更新');
              } catch (e) {
                message.error(`更新設備名稱失敗：${(e as Error).message}`);
              }
            },
          }}
        >
          {v ?? '—'}
        </Text>
      ),
    },
    {
      title: '類型',
      dataIndex: 'device_type',
      key: 'type',
      width: 120,
      render: (v: string) => <Tag color="blue">{v}</Tag>,
    },
    {
      title: '建立時間',
      dataIndex: 'created_at',
      key: 'created',
      width: 180,
      render: (v: string) => (v ? new Date(v).toLocaleString('zh-TW') : '—'),
    },
  ];

  return (
    <Table<EmsDevice>
      rowKey="device_id"
      size="small"
      pagination={false}
      dataSource={rows}
      columns={columns}
    />
  );
}
