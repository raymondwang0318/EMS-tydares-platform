import { useEffect, useMemo, useState } from 'react';
import { Table, Typography, Space, Button, Modal, Input, App, Tooltip, Alert, Badge, Tag, Spin } from 'antd';
import { ReloadOutlined, CheckOutlined, StopOutlined, ToolOutlined, PlayCircleOutlined, SyncOutlined, ScanOutlined, ClearOutlined, DeleteOutlined } from '@ant-design/icons';
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
  useRenameEdgeName,
  useDeleteDevice,
  useCleanupPlaceholders,
  type EmsDevice,
} from '../hooks/useScanWizard';

// M-PM-174 §2.2.3：hostname OS 規範守門（POSIX / RFC 952：英數字 + 連字號；不可中文）
const HOSTNAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/;
import { EdgeDrawer } from './EdgeDrawer';
import { ScanWizard } from '../components/ScanWizard';
import api from '../services/api';

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
  const renameEdgeName = useRenameEdgeName();

  // M-PM-241 §2.2 / M-P11-E11: 一鍵清除全部 placeholder
  const cleanupPlaceholders = useCleanupPlaceholders();

  /**
   * 開「清除全部掃描佔位」二次確認 dialog（v1.4 §61 兌現；輸入 CLEAR 才 enable）
   * 1. 預覽：呼叫 batch endpoint 前先 fetch 一次 GET /admin/devices 算 placeholder 數 → 不必，confirm 後直 DELETE，response 含 deleted_count
   * 2. 業主輸入「CLEAR」字串確認 enable 按鈕
   * 3. 二次確認後 DELETE /admin/devices/placeholders（batch；M-P12-054）
   */
  const openCleanupDialog = () => {
    let confirmInput = '';
    const modalRef = modal.confirm({
      title: '🧹 清除全部掃描佔位',
      icon: <ClearOutlined style={{ color: '#ff4d4f' }} />,
      width: 520,
      content: (
        <div>
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message="本操作將清除 fleet 全部 `_placeholder_*` 設備"
            description="trx_reading 歷史保留（永不動）；ems_device 軟刪除（deleted_at 設值；GET filter 自動隱藏）。對齊 M-PM-241 §2.2 業主明示『一鍵清除全部』。"
          />
          <Text type="secondary" style={{ fontSize: 12 }}>
            ⚠️ 二次確認：請輸入「CLEAR」字串解鎖按鈕（v1.4 §61 危險操作確認）
          </Text>
          <Input
            placeholder="輸入 CLEAR 解鎖確認按鈕"
            style={{ marginTop: 8 }}
            onChange={(e) => {
              confirmInput = e.target.value;
              modalRef.update({
                okButtonProps: { danger: true, disabled: confirmInput !== 'CLEAR' },
              });
            }}
          />
        </div>
      ),
      okText: '確認清除全部',
      cancelText: '取消',
      okButtonProps: { danger: true, disabled: true },
      onOk: async () => {
        if (confirmInput !== 'CLEAR') {
          message.warning('請輸入 CLEAR 確認');
          return Promise.reject();
        }
        try {
          const res = await cleanupPlaceholders.mutateAsync();
          if (res.deleted_count === 0) {
            message.info('無 placeholder 可清除（fleet 已乾淨）');
          } else {
            message.success(
              `已清除 ${res.deleted_count} 個 placeholder（影響 ${new Set(res.deleted_devices.map((d) => d.edge_id)).size} 個 Edge）`,
            );
          }
          refetch();
        } catch (err) {
          const e = err as { response?: { data?: { detail?: string } }; message?: string };
          message.error(`清除失敗：${e?.response?.data?.detail ?? e?.message ?? '未知錯誤'}`);
          throw err; // 保 dialog open
        }
      },
    });
  };

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
      width: 150,
      fixed: 'left',
      render: (id: string, record) => (
        <Button type="link" onClick={() => setDrawerEdge(record)} style={{ padding: 0, height: 'auto' }}>
          {id}
        </Button>
      ),
    },
    // 老王 5/8 chat：「名稱跟主機名的排序對調」 + rename
    //   名稱 → 設備名稱代號（業主業務命名；中文 OK；對應 edge_name；PUT /v1/admin/edges/{id}）
    //   主機名 → 主機系統名稱（OS hostname；POSIX / RFC 952 規範）
    // 對調後順序：Edge ID | 主機系統名稱 | 狀態 | 設備名稱代號 | 指紋 | ...
    {
      title: '主機系統名稱',
      dataIndex: 'hostname',
      key: 'hostname',
      width: 150,
      render: (v: string | null, record) => (
        <Text
          editable={{
            tooltip: '主機系統名稱（OS hostname）只能含英數字與連字號（POSIX / RFC 952）；中文請改填「設備名稱代號」欄位',
            onChange: async (val: string) => {
              const next = val.trim();
              if (!next || next === (v ?? '')) return;
              // M-PM-174 §2.2.3: hostname OS 規範守門
              if (!HOSTNAME_REGEX.test(next)) {
                message.error('主機系統名稱只能含英數字與連字號（OS hostname 規範）；中文請填「設備名稱代號」欄位');
                return;
              }
              try {
                await renameHostname.mutateAsync({ edgeId: record.edge_id, hostname: next });
                message.success('主機系統名稱已更新');
              } catch (e) {
                message.error(`更新主機系統名稱失敗：${(e as Error).message}`);
              }
            },
          }}
        >
          {v ?? '—'}
        </Text>
      ),
    },
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
      // M-PM-174 T-AdminUI-003：edge_name 加 editable（業務命名；中文 OK；對應 PUT /v1/admin/edges/{id}）
      title: '設備名稱代號',
      dataIndex: 'edge_name',
      key: 'edge_name',
      ellipsis: true,
      render: (v: string | null, record) => (
        <Text
          editable={{
            tooltip: '點擊編輯設備名稱代號（業務命名；可用中文，例如「警衛室 Edge02」）',
            onChange: async (val: string) => {
              const next = val.trim();
              if (!next || next === (v ?? '')) return;
              try {
                await renameEdgeName.mutateAsync({ edgeId: record.edge_id, edgeName: next });
                message.success('設備名稱代號已更新');
              } catch (e) {
                message.error(`更新設備名稱代號失敗：${(e as Error).message}`);
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
      width: 160,
      render: (fp: string | null) => (
        <Tooltip title={fp ?? '尚未 enroll'}>
          <Text code style={{ fontSize: 12 }}>{shortFp(fp)}</Text>
        </Tooltip>
      ),
    },
    {
      title: '設定版本',
      dataIndex: 'config_version',
      key: 'config_version',
      width: 110,
      align: 'right',
      render: (v: number) => <Badge count={v} showZero color="#1677ff" overflowCount={9999} />,
    },
    {
      // M-PM-306 衍生：edge 核心 CPU 溫度（edge_host_monitor 每 60s 上報）
      title: '核心溫度',
      dataIndex: 'cpu_temp_c',
      key: 'cpu_temp_c',
      width: 110,
      align: 'right',
      render: (t: number | null, record) => {
        if (t == null) return <Text type="secondary">—</Text>;
        // 分級依 Raspberry Pi 4B 原廠 datasheet（晶片溫度 thermal_zone0）：
        //   <70 正常 / 70-80 偏高（接近降頻）/ 80-85 過熱（80°C 起降頻 throttle）/ ≥85 危險（強制節流）
        const lv =
          t >= 85 ? { color: '#820014', tip: '危險：已達 85°C 強制節流（原廠上限）' } :
          t >= 80 ? { color: '#cf1322', tip: '過熱：已達 80°C 起始降頻（throttle）' } :
          t >= 70 ? { color: '#fa8c16', tip: '偏高：接近 80°C 降頻點；環境溫度可能逼近原廠建議 50°C 上限' } :
                    { color: '#3f8600', tip: '正常：晶片溫度遠低於 80°C 降頻點' };
        const sampledAt = record.cpu_temp_at ? `\n取樣：${formatTime(record.cpu_temp_at)}` : '';
        return (
          <Tooltip title={`${lv.tip}${sampledAt}`}>
            <Text strong style={{ color: lv.color }}>{t.toFixed(1)} °C</Text>
          </Tooltip>
        );
      },
      sorter: (a, b) => (a.cpu_temp_c ?? -1) - (b.cpu_temp_c ?? -1),
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
      width: 300,
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
        <Space>
          {/* M-PM-241 §2.2 / M-P11-E11：一鍵清除全部掃描佔位（業主 5/19 chat 明示；二次確認 §61 兌現）*/}
          <Button icon={<ClearOutlined />} danger onClick={openCleanupDialog}>
            清除全部掃描佔位
          </Button>
          <Button icon={<ReloadOutlined />} loading={isFetching} onClick={() => refetch()}>
            重新整理
          </Button>
        </Space>
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
        scroll={{ x: 1400 }}
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

/**
 * M-PM-267 §三: device → ECSU 反查綁定狀態（刪除對話框用）
 * backend: GET /v1/admin/devices/{device_id}/ecsu-bindings（M-P12-068 commit da1fd44）
 * 顯示：有綁 → ⚠️ N 個 ECSU + 清單；無綁 → ✅ 可安全刪除
 */
interface EcsuBinding {
  assgn_id: number;
  ecsu_id: number;
  ecsu_code: string;
  ecsu_name: string;
  region: string | null;
  circuit_code: string;
  sign: number;
  enabled: boolean;
  remark_desc: string | null;
}

function DeviceEcsuBindingsInfo({ deviceId }: { deviceId: string }) {
  const [loading, setLoading] = useState(true);
  const [bindings, setBindings] = useState<EcsuBinding[]>([]);

  useEffect(() => {
    api
      .get<{ bindings: EcsuBinding[] }>(`/admin/devices/${deviceId}/ecsu-bindings`)
      .then((res) => setBindings(res.data.bindings))
      .catch(() => setBindings([]))
      .finally(() => setLoading(false));
  }, [deviceId]);

  if (loading) {
    return (
      <div style={{ padding: '8px 0', display: 'flex', alignItems: 'center', gap: 8 }}>
        <Spin size="small" />
        <Text type="secondary" style={{ fontSize: 12 }}>查詢 ECSU 綁定中…</Text>
      </div>
    );
  }

  if (bindings.length === 0) {
    return (
      <Alert
        type="success"
        showIcon
        style={{ marginBottom: 12 }}
        message="✅ 此設備未被任何 ECSU 綁定，可安全刪除"
      />
    );
  }

  return (
    <Alert
      type="warning"
      showIcon
      style={{ marginBottom: 12 }}
      message={`⚠️ 此設備被 ${bindings.length} 個 ECSU 綁定，刪除前請先解綁`}
      description={
        <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>
          {bindings.map((b) => (
            <li key={b.assgn_id}>
              <Text code>{b.ecsu_code}</Text>
              {b.region ? ` · ${b.region}` : ''}
              {` · ${b.ecsu_name}`}
              {!b.enabled && <Text type="secondary"> （已停用）</Text>}
            </li>
          ))}
        </ul>
      }
    />
  );
}

function EdgeDevicesTable({ edgeId }: { edgeId: string }) {
  const { data: devices, isLoading, error, refetch } = useEdgeDevices(edgeId);
  const renameDevice = useRenameDevice();
  const deleteDevice = useDeleteDevice();
  const { message, modal } = App.useApp();

  /**
   * M-PM-241 §2.2 / M-P11-E11: per-row 手動刪除 device（業主 5/19 chat 明示）
   * - 主要對 placeholder 用；但同 confirm dialog pattern 也支援 real device（業主自決）
   * - 二次確認：輸入完整 device_id 或場域代碼解鎖（v1.4 §61）
   * - DELETE /v1/admin/devices/{device_id}（既有 soft_delete_device）
   */
  const openDeleteDeviceDialog = (dev: EmsDevice) => {
    const isPlaceholder = dev.device_id.startsWith('_placeholder_');
    let confirmInput = '';
    const expectedConfirm = dev.device_id;
    const modalRef = modal.confirm({
      title: isPlaceholder ? '🗑 刪除掃描佔位' : '🗑 刪除設備',
      icon: <DeleteOutlined style={{ color: '#ff4d4f' }} />,
      width: 520,
      content: (
        <div>
          <Alert
            type={isPlaceholder ? 'info' : 'warning'}
            showIcon
            style={{ marginBottom: 12 }}
            message={isPlaceholder ? '掃描佔位（ScanWizard bootstrap）' : '⚠️ 真實設備（非掃描佔位）'}
            description={isPlaceholder
              ? '本操作軟刪除（deleted_at 設值；GET filter 自動隱藏）；trx_reading 歷史保留。'
              : 'trx_reading 歷史保留；刪除後聚合與驅動中斷。請確認此 device 已停用。'}
          />
          {/* M-PM-267 §三: 真實設備顯示 ECSU 反查綁定狀態（取代模糊「ECSU 綁定可能變孤兒」警告）*/}
          {!isPlaceholder && <DeviceEcsuBindingsInfo deviceId={dev.device_id} />}
          <div style={{ marginBottom: 8 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>device_id:</Text>{' '}
            <Text code copyable={{ text: dev.device_id }}>{dev.device_id}</Text>
          </div>
          {dev.device_name && (
            <div style={{ marginBottom: 8 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>名稱:</Text>{' '}
              <Text>{dev.device_name}</Text>
            </div>
          )}
          <Text type="secondary" style={{ fontSize: 12 }}>
            ⚠️ 二次確認：請輸入完整 device_id 解鎖按鈕（v1.4 §61）
          </Text>
          <Input
            placeholder={`輸入 ${expectedConfirm.length > 24 ? expectedConfirm.slice(0, 24) + '…' : expectedConfirm} 解鎖`}
            style={{ marginTop: 8 }}
            onChange={(e) => {
              confirmInput = e.target.value;
              modalRef.update({
                okButtonProps: { danger: true, disabled: confirmInput !== expectedConfirm },
              });
            }}
          />
        </div>
      ),
      okText: '確認刪除',
      cancelText: '取消',
      okButtonProps: { danger: true, disabled: true },
      onOk: async () => {
        if (confirmInput !== expectedConfirm) {
          message.warning('device_id 不對；請輸入完整 device_id');
          return Promise.reject();
        }
        try {
          await deleteDevice.mutateAsync(dev.device_id);
          message.success(`已刪除 ${isPlaceholder ? '掃描佔位' : '設備'}：${dev.device_id}`);
          refetch();
        } catch (err) {
          const e = err as { response?: { data?: { detail?: string } }; message?: string };
          message.error(`刪除失敗：${e?.response?.data?.detail ?? e?.message ?? '未知錯誤'}`);
          throw err;
        }
      },
    });
  };

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

  // M-PM-241 §2.2 / M-P11-E11: 顯示 placeholder rows（業主可手動刪）；既有 filter `d.device_type !== '_placeholder'`
  // 因 useEdgeDevices transform device_kind ('other') → device_type 不會是 '_placeholder' 字串 → filter 永遠 true
  // (5/19 業主截圖 E06 placeholder 顯示 = filter 不工作的證據)
  // 修法：放行所有 row 顯示；placeholder row 由業務命名 + [🗑] icon 提供 UX 區別
  const rows = devices ?? [];
  if (rows.length === 0) return <Text type="secondary">尚無已註冊設備</Text>;

  const columns: ColumnsType<EmsDevice> = [
    {
      title: 'Device ID',
      dataIndex: 'device_id',
      key: 'device_id',
      width: 260,
      render: (v: string) => {
        const isPlaceholder = v.startsWith('_placeholder_');
        return (
          <Space size={4}>
            {isPlaceholder && <Tag color="orange">掃描佔位</Tag>}
            <Text code={isPlaceholder} style={isPlaceholder ? { color: '#fa8c16' } : undefined}>{v}</Text>
          </Space>
        );
      },
    },
    {
      title: '名稱',
      dataIndex: 'device_name',
      key: 'name',
      render: (v: string | null, row: EmsDevice) => {
        const isPlaceholder = row.device_id.startsWith('_placeholder_');
        if (isPlaceholder) {
          return <Text type="secondary">{v ?? '掃描佔位（Wizard bootstrap）'}</Text>;
        }
        return (
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
        );
      },
    },
    {
      title: '類型',
      dataIndex: 'device_type',
      key: 'type',
      width: 120,
      render: (v: string, row: EmsDevice) => {
        const isPlaceholder = row.device_id.startsWith('_placeholder_');
        return <Tag color={isPlaceholder ? 'orange' : 'blue'}>{v}</Tag>;
      },
    },
    {
      title: '建立時間',
      dataIndex: 'created_at',
      key: 'created',
      width: 180,
      render: (v: string) => (v ? new Date(v).toLocaleString('zh-TW') : '—'),
    },
    {
      title: '操作',
      key: 'action',
      width: 90,
      align: 'center',
      render: (_: unknown, row: EmsDevice) => (
        <Tooltip title={row.device_id.startsWith('_placeholder_') ? '刪除掃描佔位' : '刪除設備（危險；trx_reading 保留）'}>
          <Button
            size="small"
            danger
            icon={<DeleteOutlined />}
            onClick={() => openDeleteDeviceDialog(row)}
          />
        </Tooltip>
      ),
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
