import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Checkbox,
  Descriptions,
  Input,
  InputNumber,
  Modal,
  Radio,
  Select,
  Space,
  Spin,
  Steps,
  Table,
  Tag,
  Typography,
} from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  DeleteOutlined,
  PlusOutlined,
  ScanOutlined,
} from '@ant-design/icons';
import {
  fetchCommand,
  useBootstrapEdgeDevice,
  useConfirmDevices,
  useCreateCommand,
  useDeleteDevice,
  useEdgeDevices,
  type CommandStatus,
  type ConfirmDevice,
  type EmsDevice,
  type ScanCircuit,
  type ScanDevice,
} from '../hooks/useScanWizard';

const { Text } = Typography;

// M-PM-242 §3.3 / M-P11-E12: 加遠端 I/O 類型（業主 5/20『Edge 管理掃描設備按鈕還沒把遠端 I/O 加進來』）
// backend M-P12-055 §3.2 device_circuits.py 已加 tcs300b03_di × 16 + tcs300b04_do × 16
// 對齊 vault SSOT v1.0：6 控制箱 × 4 device = 24 fleet（slave 1-3 TCS300B03 DI；slave 4 TCS300B04 DO）
// ⚠️ Edge 端 PROBE_ORDER + scanner SUPPORTED_TYPES 仍待 P10C 補（M-P12-055 §二 升報移交）；
// P11E frontend 提供下拉選項；scan 觸發後 backend ingest 識別需 P10C driver source ready
const DEVICE_TYPES = [
  { value: 'cpm12d', label: 'CPM-12D' },
  { value: 'cpm23', label: 'CPM-23' },
  { value: 'aem_drb', label: 'AEM-DRB' },
  { value: 'tcs300b03_di', label: 'TCS300B03 數位輸入 (DI16)' },
  { value: 'tcs300b04_do', label: 'TCS300B04 數位輸出 (DO16)' },
];

type WizardStep = 'config' | 'scanning' | 'confirm';

interface ScanPlanEntry {
  key: number;
  slave_id: number;
  device_type: string;
}

interface TransportMemory {
  transport: 'tcp' | 'rs485';
  tcpHost: string;
  tcpPort: number;
  rs485Port: string;
  rs485Baud: number;
}

const LS_KEY_PREFIX = 'ems.scanWizard.transport.';

function loadTransportMemory(edgeId: string): TransportMemory | null {
  try {
    const raw = localStorage.getItem(LS_KEY_PREFIX + edgeId);
    return raw ? (JSON.parse(raw) as TransportMemory) : null;
  } catch {
    return null;
  }
}

function saveTransportMemory(edgeId: string, m: TransportMemory): void {
  try {
    localStorage.setItem(LS_KEY_PREFIX + edgeId, JSON.stringify(m));
  } catch {
    /* ignore */
  }
}

interface ConfirmRow extends ScanDevice {
  checked: boolean;
  device_name: string;
}

export interface ScanWizardProps {
  edgeId: string | null;
  open: boolean;
  onClose: () => void;
}

export function ScanWizard({ edgeId, open, onClose }: ScanWizardProps) {
  const { message } = App.useApp();
  const { data: devicesData, refetch: refetchDevices } = useEdgeDevices(edgeId);
  const bootstrap = useBootstrapEdgeDevice();
  const createCommand = useCreateCommand();
  const confirmDevicesMut = useConfirmDevices();
  // T-AdminUI-005 (M-PM-188 §2.2): rollback DELETE placeholder hook
  const deleteDevice = useDeleteDevice();

  const [wizardStep, setWizardStep] = useState<WizardStep>('config');

  const [transport, setTransport] = useState<'tcp' | 'rs485'>('tcp');
  const [tcpHost, setTcpHost] = useState('192.168.10.181');
  const [tcpPort, setTcpPort] = useState(502);
  const [rs485Port, setRs485Port] = useState('/dev/ttyS0');
  const [rs485Baud, setRs485Baud] = useState(9600);
  const [scanPlan, setScanPlan] = useState<ScanPlanEntry[]>([
    { key: 1, slave_id: 1, device_type: 'cpm12d' },
  ]);
  const nextKeyRef = useRef(2);

  const [scanStatus, setScanStatus] = useState<CommandStatus | null>(null);
  const [scanResults, setScanResults] = useState<ScanDevice[]>([]);
  const [scanLatency, setScanLatency] = useState<number | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const [confirmRows, setConfirmRows] = useState<ConfirmRow[]>([]);

  // T-AdminUI-005 (M-PM-188 §2.2): bootstrap placeholder rollback state
  // - placeholderIdRef: 本 session bootstrap 出的 placeholder device_id（記住才能 rollback）
  // - confirmedRef: 標記 confirm 已成功；若 true → closeModal 不 rollback
  // - rollbackingRef: 防止 closeModal 被 rollback 自身觸發遞迴
  //
  // M-PM-227 修：原 useState 改 useRef pattern（無 UI 直讀；只給 callback 用）
  // 根因：M-P11-059 原碼用 useState；startScan 內 setInterval polling callback 的 closure 凍結
  //       state 為 setState 之前的值（null）；scan FAILED auto-clean 條件永遠 false → placeholder
  //       留 DB（M-P12-047 採證 4 row 鐵證；含 5/16 E05 在 M-P11-059 deploy 後仍新生）。
  //       ref 讀寫不受 closure 凍結影響 → callback 內讀到的永遠是最新值。
  const placeholderIdRef = useRef<string | null>(null);
  const confirmedRef = useRef(false);
  const rollbackingRef = useRef(false);

  // M-PM-227 helper：寫 ref；無 state（無 UI 直讀；Modal.confirm content 在 imperative 呼叫時靜態快照）
  const setPlaceholderId = useCallback((id: string | null) => {
    placeholderIdRef.current = id;
  }, []);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = undefined;
    }
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = undefined;
    }
  }, []);

  useEffect(() => {
    return () => stopPolling();
  }, [stopPolling]);

  const inferDefaults = useCallback((devices: EmsDevice[]) => {
    // M-P11-052 修：useEdgeDevices 改用 GET /v1/admin/devices 後 device_type 不再可靠
    // （V2-final backend 只存 device_kind = 'modbus_meter' 等寬泛分類；不存 cpm12d/cpm23/aem_drb fine-grained）
    // 改用 device_id prefix filter 排 placeholder + 從 device_id parse device_type
    const real = devices.filter(
      (d) => !d.device_id.startsWith('_placeholder') && !d.device_id.startsWith('_scan-'),
    );
    // M-PM-242 §3.3: 加 tcs300b03_di / tcs300b04_do（device_id prefix 推導 type）
    // 舊 'tcs300b03' 保留 backward compat（早期命名；ScanWizard inferDefaults 用 prefix match）
    const KNOWN_TYPES = ['cpm12d', 'cpm23', 'aem_drb', 'tcs300b03_di', 'tcs300b04_do', 'tcs300b03'];
    const entries: ScanPlanEntry[] = real.map((d, i) => {
      const slaveMatch = d.device_id.match(/slave(\d+)/);
      const typeMatch = KNOWN_TYPES.find((t) => d.device_id.startsWith(`${t}-`));
      return {
        key: i + 1,
        slave_id: slaveMatch ? parseInt(slaveMatch[1], 10) : i + 1,
        device_type: typeMatch ?? d.device_type ?? 'cpm12d',
      };
    });
    nextKeyRef.current = entries.length + 1;
    if (entries.length > 0) {
      setScanPlan(entries);
    } else {
      setScanPlan([{ key: 1, slave_id: 1, device_type: 'cpm12d' }]);
      nextKeyRef.current = 2;
    }
  }, []);

  useEffect(() => {
    if (!open || !edgeId) return;

    setWizardStep('config');
    setScanStatus(null);
    setScanResults([]);
    setScanLatency(null);
    setScanError(null);
    setElapsedSec(0);
    setConfirmRows([]);
    // T-AdminUI-005: 重置 rollback state（每次 modal open 都新 session）
    // M-PM-227: 同步重置 ref（state + ref 雙軌）
    setPlaceholderId(null);
    confirmedRef.current = false;
    rollbackingRef.current = false;
    stopPolling();

    const mem = loadTransportMemory(edgeId);
    if (mem) {
      setTransport(mem.transport);
      setTcpHost(mem.tcpHost);
      setTcpPort(mem.tcpPort);
      setRs485Port(mem.rs485Port);
      setRs485Baud(mem.rs485Baud);
    }

    refetchDevices().then((res) => {
      const fresh = Array.isArray(res.data) ? res.data : [];
      inferDefaults(fresh);
    });
    // M-PM-134 補修：deps 收斂只 [open, edgeId]；移除 inferDefaults / refetchDevices / stopPolling
    // 避免 react-query refetch ref 不穩 → effect 重跑 → setElapsedSec(0) + stopPolling() → timer 永遠被砍
    // 老王 2026-05-06 chat ground truth：「已等待 0 秒」永遠不計數 + scanStatus 卡 'QUEUED' 不變
    // 三個 helpers 都是 useCallback([]) 穩定的；用 ref pattern 保證讀到最新即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, edgeId]);

  const startScan = async () => {
    if (!edgeId) return;

    saveTransportMemory(edgeId, { transport, tcpHost, tcpPort, rs485Port, rs485Baud });

    let devices = devicesData ?? [];

    if (devices.length === 0) {
      try {
        const { device_id } = await bootstrap.mutateAsync(edgeId);
        const placeholder: EmsDevice = {
          device_id,
          edge_id: edgeId,
          device_type: '_placeholder',
          device_name: '掃描佔位',
          created_at: new Date().toISOString(),
        };
        devices = [placeholder];
        // T-AdminUI-005: 記住本 session bootstrap 出的 placeholder；rollback 時 DELETE
        // M-PM-227: ref + state 雙軌寫；ref 供 setInterval polling callback closure 讀（state stale）
        setPlaceholderId(device_id);
      } catch {
        message.error('建立佔位設備失敗，無法發起掃描。');
        return;
      }
    }

    if (scanPlan.length === 0) {
      message.warning('請至少新增一個掃描項目。');
      return;
    }

    setWizardStep('scanning');
    setScanStatus(null);
    setScanResults([]);
    setScanLatency(null);
    setScanError(null);
    setElapsedSec(0);

    try {
      const payload: Record<string, unknown> = {
        scan_plan: scanPlan.map((e) => ({ slave_id: e.slave_id, device_type: e.device_type })),
        transport,
        phase2: true,
        auto_confirm: false,
      };
      if (transport === 'tcp') {
        payload.host = tcpHost;
        payload.tcp_port = tcpPort;
      } else {
        payload.port = rs485Port;
        payload.baudrate = rs485Baud;
      }

      // M-PM-134 修：backend `/v1/commands` 期待 edge_id top-level（device.scan 是 edge-level command）
      // 老王 2026-05-06 19:00 chat 採證 ground truth：缺 edge_id → 422
      // 既有送 device_id placeholder 不是必要；保留 bootstrap 流程供 confirm 階段使用，但 createCommand 改送 edge_id
      const { command_id } = await createCommand.mutateAsync({
        edge_id: edgeId,
        command_type: 'device.scan',
        payload,
        issued_by: 'admin-ui',
      });

      setScanStatus('QUEUED');

      timerRef.current = setInterval(() => setElapsedSec((s) => s + 1), 1000);

      pollRef.current = setInterval(async () => {
        try {
          const cmd = await fetchCommand(command_id);
          if (!cmd) return;
          setScanStatus(cmd.status);
          if (cmd.status === 'SUCCEEDED' && cmd.result_json) {
            const result = cmd.result_json as Record<string, unknown>;
            setScanResults((result.scan_results as ScanDevice[]) || []);
            setScanLatency((result.latency_ms as number) ?? null);
            stopPolling();
          } else if (['FAILED', 'EXPIRED', 'CANCELED'].includes(cmd.status)) {
            const result = cmd.result_json as Record<string, unknown> | null;
            setScanError((result?.error as string) || '未知錯誤');
            stopPolling();
            // T-AdminUI-005 (M-PM-188 §2.2.1): scan FAILED/EXPIRED/CANCELED → 自動 DELETE placeholder
            // - 不彈 dialog（command 已失敗；老王不需再決定；自動清最徹底）
            // - 用 setPlaceholderId(null) 跳過後續 closeModal 二次 rollback
            //
            // M-PM-227 根因修：原碼用 `bootstrappedPlaceholderId` state 變數，但本 setInterval callback
            // 是在 startScan 開始時建立，closure 凍結 state = null（setBootstrappedPlaceholderId 後續
            // 寫入無法穿透 closure）→ 此 if 永遠 false → auto-clean 從未真正執行 → M-P12-047 採證
            // 4 row placeholder 殘留鐵證（含 5/16 E05 在 M-P11-059 deploy 後新生）。
            // 改讀 placeholderIdRef.current（ref 不受 closure 凍結）→ auto-clean 修通。
            const id = placeholderIdRef.current;
            if (id && !confirmedRef.current) {
              setPlaceholderId(null); // 立即清避免 closeModal 二次彈 dialog
              performRollback(id).catch(() => {
                /* performRollback 內已 toast；不再 throw */
              });
            }
          }
        } catch {
          /* ignore polling errors */
        }
      }, 2000);
    } catch {
      message.error('掃描指令送出失敗');
      setWizardStep('config');
    }
  };

  const goToConfirm = () => {
    if (!edgeId) return;
    const rows: ConfirmRow[] = scanResults.map((dev) => ({
      ...dev,
      checked: dev.online,
      device_name: `${dev.device_type}-${edgeId}-slave${dev.slave_id}`,
    }));
    setConfirmRows(rows);
    setWizardStep('confirm');
  };

  const handleConfirm = async () => {
    if (!edgeId) return;
    const selected = confirmRows.filter((r) => r.checked);
    if (selected.length === 0) {
      message.warning('請至少勾選一台設備。');
      return;
    }

    try {
      const devices: ConfirmDevice[] = selected.map((r) => ({
        device_id: `${r.device_type}-${edgeId}-slave${r.slave_id}`,
        device_type: r.device_type,
        device_name: r.device_name,
        slave_id: r.slave_id,
        bus_id: r.bus_id,
        circuits: (r.circuits || [])
          .filter((c) => c.configured)
          .map((c) => ({ circuit: c.circuit, ct_pri: c.ct_pri, wire: c.wire_type })),
      }));

      const res = await confirmDevicesMut.mutateAsync({ edgeId, devices });
      const label =
        res.created_count > 0
          ? `已建立 ${res.created_count} 台設備`
          : `設備已存在（${selected.length} 筆），未新增`;
      message.success(
        `${label}，配置指令已下發 (${res.command_id.slice(0, 8)}...)`,
      );
      // T-AdminUI-005: confirm 成功 → 標記跳過 rollback
      //
      // M-P11-E06 修：原 comment「prev placeholder 已被 confirm flow 替換」假設不對 —
      // backend confirm cleanup (v1_admin.py L301) 寫死舊命名 `_scan-{edge_id}`；
      // ScanWizard 改用 `_placeholder_{hex}` 後 backend cleanup 永遠 0 row → placeholder 殘留
      // (5/17 老王 E10 鐵證；created_at 與真實 device 相差 19s)。
      // 修法雙保險：
      //   (1) backend cleanup 改 LIKE '_placeholder_%' (本卷 v1_admin.py L301 同步修)
      //   (2) frontend explicit DELETE placeholder (本卷；防 old image / cleanup 失敗)
      // confirmedRef.current = true 標記跳過 closeModal rollback dialog（confirm 流程不需問業主）
      const placeholderToCleanup = placeholderIdRef.current;
      confirmedRef.current = true;
      stopPolling();
      // 顯式清 placeholder（best-effort；backend 應已清；本 frontend 為雙保險）
      if (placeholderToCleanup) {
        deleteDevice.mutateAsync(placeholderToCleanup).catch(() => {
          // 已被 backend 清 → 404；忽略
        });
      }
      onClose();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      const detail = e?.response?.data?.detail ?? e?.message ?? '未知錯誤';
      message.error(`確認建立失敗：${detail}`);
    }
  };

  // T-AdminUI-005 (M-PM-188 §2.2): 內部執行 rollback DELETE placeholder
  // - best-effort：DELETE 失敗 toast 警告 + console.error 留證；不阻塞 modal 關閉
  // - 重用 deleteDevice mutation；onSuccess 會 invalidate devices query
  const performRollback = useCallback(async (placeholderId: string) => {
    try {
      await deleteDevice.mutateAsync(placeholderId);
      message.success(
        `已自動清除暫存設備 ${placeholderId.slice(0, 16)}…（防 dirty data 累積）`,
      );
    } catch (err) {
      console.error('[ScanWizard] rollback DELETE failed', err);
      message.warning(
        `暫存設備清除失敗（${placeholderId.slice(0, 16)}…）；請聯繫 admin 手動清理`,
      );
    }
  }, [deleteDevice, message]);

  const closeModal = useCallback(() => {
    stopPolling();
    // T-AdminUI-005 (M-PM-188 §2.2.2): 取消 wizard → 若有 bootstrap placeholder + 未成功 confirm → confirm dialog 詢問清除
    // - confirmedRef true（已成功 confirm）→ 直接關閉，不 rollback
    // - placeholderIdRef null（從未 bootstrap）→ 直接關閉，無 rollback 對象
    // - 其他情況 → 彈 confirm dialog；老王自決清/留
    //
    // M-PM-227 防禦：原碼讀 bootstrappedPlaceholderId state；本 closeModal 是 useCallback with deps，
    // closure 隨 state 變更重建，理論上正確。改讀 placeholderIdRef.current 作為 source of truth：
    //   (a) 與 setInterval polling closure 修法一致；單一寫法
    //   (b) 防禦 Modal.confirm onOk 在 await performRollback 期間的任何 ref 變動（例如 polling FAILED
    //       同時觸發 auto-clean）→ id 取自閉包局部變數 + ref re-check 雙保險
    if (rollbackingRef.current) {
      // 防 dialog onOk 內又呼叫 closeModal 遞迴
      onClose();
      return;
    }
    const currentPlaceholderId = placeholderIdRef.current;
    if (!currentPlaceholderId || confirmedRef.current) {
      onClose();
      return;
    }
    rollbackingRef.current = true;
    Modal.confirm({
      title: '取消掃描？',
      content: `偵測到本次有 1 個暫存設備（${currentPlaceholderId.slice(
        0,
        16,
      )}…）；取消後是否清除？\n\n建議「清除」避免累積 dirty data；「保留」可下次重開 wizard 復用。`,
      okText: '取消並清除暫存',
      cancelText: '取消但保留暫存',
      onOk: async () => {
        // M-PM-227: ref re-check（防 polling FAILED 同時清掉 ref；雙保險）
        const id = placeholderIdRef.current ?? currentPlaceholderId;
        if (id) {
          await performRollback(id);
          setPlaceholderId(null);
        }
        rollbackingRef.current = false;
        onClose();
      },
      onCancel: () => {
        rollbackingRef.current = false;
        onClose();
      },
    });
  }, [onClose, performRollback, stopPolling, setPlaceholderId]);

  const addPlanEntry = useCallback(() => {
    setScanPlan((prev) => [
      ...prev,
      { key: nextKeyRef.current++, slave_id: prev.length + 1, device_type: 'cpm12d' },
    ]);
  }, []);
  const removePlanEntry = useCallback((key: number) => {
    setScanPlan((prev) => prev.filter((e) => e.key !== key));
  }, []);
  const updatePlanEntry = useCallback((
    key: number,
    field: 'slave_id' | 'device_type',
    value: number | string,
  ) => {
    // M-PM-132 候選 C 採證：留 console.error 級別 trace 方便老王 F12 看 onChange 是否真的觸發 + state 是否更新
    console.log('[ScanWizard.updatePlanEntry]', { key, field, value });
    setScanPlan((prev) => {
      const next = prev.map((e) => (e.key === key ? { ...e, [field]: value } : e));
      console.log('[ScanWizard.updatePlanEntry] state updated', { prev, next });
      return next;
    });
  }, []);

  // M-PM-132 修：columns 抽 useMemo 穩定 reference；避免每次 ScanWizard re-render
  // 重建 columns array 導致 antd Table cell stale closure 抓不到最新 r.device_type
  const scanPlanColumns = useMemo(
    () => [
      {
        title: 'Slave ID',
        dataIndex: 'slave_id',
        key: 'slave_id',
        width: 120,
        render: (v: number, r: ScanPlanEntry) => (
          <InputNumber
            value={v}
            min={1}
            max={247}
            size="small"
            onChange={(val) => updatePlanEntry(r.key, 'slave_id', val ?? 1)}
          />
        ),
      },
      {
        title: '設備類型',
        dataIndex: 'device_type',
        key: 'device_type',
        render: (_v: string, r: ScanPlanEntry) => (
          // M-PM-132 修：顯式從 r.device_type 取值（避免 antd dataIndex render 第一參數 stale 風險）
          // + key={r.key + '-' + r.device_type} 確保 device_type 變動 Select 立即 re-mount 顯新值
          <Select
            key={`${r.key}-${r.device_type}`}
            value={r.device_type}
            size="small"
            style={{ width: 160 }}
            onChange={(val) => updatePlanEntry(r.key, 'device_type', val)}
            options={DEVICE_TYPES}
          />
        ),
      },
      {
        title: '',
        key: 'action',
        width: 60,
        render: (_: unknown, r: ScanPlanEntry) => (
          <Button
            size="small"
            danger
            icon={<DeleteOutlined />}
            onClick={() => removePlanEntry(r.key)}
            disabled={scanPlan.length <= 1}
          />
        ),
      },
    ],
    [updatePlanEntry, removePlanEntry, scanPlan.length],
  );

  const scanStepIndex = useMemo(() => {
    switch (scanStatus) {
      case 'QUEUED':
        return 0;
      case 'DELIVERED':
        return 1;
      case 'RUNNING':
        return 2;
      case 'SUCCEEDED':
      case 'FAILED':
      case 'EXPIRED':
      case 'CANCELED':
        return 3;
      default:
        return 0;
    }
  }, [scanStatus]);

  const scanStatusMessage = useMemo(() => {
    switch (scanStatus) {
      case 'QUEUED':
        return '指令已建立，等待 Edge 領取...';
      case 'DELIVERED':
        return 'Edge 已領取指令，準備掃描...';
      case 'RUNNING':
        return `正在掃描 Modbus 設備，請稍候... (${elapsedSec}s)`;
      case 'SUCCEEDED':
        return `掃描完成！共發現 ${scanResults.length} 台設備，耗時 ${
          scanLatency ? (scanLatency / 1000).toFixed(1) : '?'
        } 秒`;
      case 'FAILED':
      case 'EXPIRED':
        return null;
      default:
        return '準備中...';
    }
  }, [scanStatus, elapsedSec, scanResults.length, scanLatency]);

  // M-PM-138 修：原 useMemo deps 缺 [startScan, goToConfirm, handleConfirm, scanPlan]
  // → button onClick 抓 mount-time stale closure → scan_plan 永遠送 default cpm12d slave 1
  // → P12 DB ground truth 採證鐵證（M-P12-031）老王 UI 配 9 設備但 POST body 1 cpm12d default
  // 最 surgical 修：改 IIFE 每次 render 重建（cost 微小；徹底解 stale closure）
  const modalFooter = (() => {
    switch (wizardStep) {
      case 'config':
        return [
          <Button key="cancel" onClick={closeModal}>
            取消
          </Button>,
          <Button
            key="scan"
            type="primary"
            icon={<ScanOutlined />}
            onClick={startScan}
            loading={bootstrap.isPending || createCommand.isPending}
          >
            開始掃描
          </Button>,
        ];
      case 'scanning':
        if (scanStatus === 'SUCCEEDED') {
          return [
            <Button key="back" onClick={() => setWizardStep('config')}>
              重新設定
            </Button>,
            <Button
              key="confirm"
              type="primary"
              onClick={goToConfirm}
              disabled={scanResults.length === 0}
            >
              確認建立設備
            </Button>,
          ];
        }
        if (scanStatus === 'FAILED' || scanStatus === 'EXPIRED' || scanStatus === 'CANCELED') {
          return [
            <Button key="retry" onClick={() => setWizardStep('config')}>
              重新掃描
            </Button>,
          ];
        }
        return null;
      case 'confirm':
        return [
          <Button key="back" onClick={() => setWizardStep('scanning')}>
            返回結果
          </Button>,
          <Button
            key="submit"
            type="primary"
            loading={confirmDevicesMut.isPending}
            onClick={handleConfirm}
            disabled={confirmRows.filter((r) => r.checked).length === 0}
          >
            確認建立 {confirmRows.filter((r) => r.checked).length} 台設備
          </Button>,
        ];
    }
  })();

  return (
    <Modal
      title={`設備掃描 — ${edgeId ?? ''}`}
      open={open}
      onCancel={closeModal}
      footer={modalFooter}
      width={800}
      maskClosable={false}
      destroyOnHidden
    >
      <Steps
        current={wizardStep === 'config' ? 0 : wizardStep === 'scanning' ? 1 : 2}
        size="small"
        style={{ marginBottom: 24 }}
        items={[{ title: '掃描設定' }, { title: '掃描中' }, { title: '確認建立' }]}
      />

      {wizardStep === 'config' && (
        <div>
          <div style={{ marginBottom: 16 }}>
            <Text strong>通訊方式</Text>
            <div style={{ marginTop: 8 }}>
              <Radio.Group
                value={transport}
                onChange={(e) => setTransport(e.target.value as 'tcp' | 'rs485')}
              >
                <Radio value="tcp">TCP (Modbus TCP)</Radio>
                <Radio value="rs485">RS485 (Serial)</Radio>
              </Radio.Group>
            </div>
            <div style={{ marginTop: 8, display: 'flex', gap: 12 }}>
              {transport === 'tcp' ? (
                <>
                  <Input
                    addonBefore="Host"
                    value={tcpHost}
                    onChange={(e) => setTcpHost(e.target.value)}
                    style={{ width: 240 }}
                  />
                  <InputNumber
                    addonBefore="Port"
                    value={tcpPort}
                    onChange={(v) => setTcpPort(v ?? 502)}
                    min={1}
                    max={65535}
                    style={{ width: 160 }}
                  />
                </>
              ) : (
                <>
                  <Input
                    addonBefore="Port"
                    value={rs485Port}
                    onChange={(e) => setRs485Port(e.target.value)}
                    style={{ width: 240 }}
                  />
                  <InputNumber
                    addonBefore="Baud"
                    value={rs485Baud}
                    onChange={(v) => setRs485Baud(v ?? 9600)}
                    style={{ width: 160 }}
                  />
                </>
              )}
            </div>
          </div>

          <div>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 8,
              }}
            >
              <Text strong>掃描清單</Text>
              <Button size="small" icon={<PlusOutlined />} onClick={addPlanEntry}>
                新增探測
              </Button>
            </div>
            <Table
              dataSource={scanPlan}
              rowKey="key"
              size="small"
              pagination={false}
              columns={scanPlanColumns}
            />
          </div>
        </div>
      )}

      {wizardStep === 'scanning' && (
        <div>
          <Steps
            current={scanStepIndex}
            status={scanStatus === 'FAILED' || scanStatus === 'EXPIRED' ? 'error' : undefined}
            size="small"
            style={{ marginBottom: 24 }}
            items={[
              { title: '建立指令' },
              { title: 'Edge 領取' },
              { title: '掃描設備' },
              {
                title:
                  scanStatus === 'FAILED' || scanStatus === 'EXPIRED' ? '失敗' : '完成',
              },
            ]}
          />

          {scanStatusMessage && (
            <div style={{ textAlign: 'center', padding: 16 }}>
              {scanStatus === 'SUCCEEDED' ? (
                <div>
                  <CheckCircleOutlined
                    style={{ fontSize: 32, color: '#52c41a', marginBottom: 8 }}
                  />
                  <div style={{ fontSize: 16 }}>{scanStatusMessage}</div>
                </div>
              ) : (
                <div>
                  <Spin style={{ marginBottom: 8 }} />
                  <div style={{ color: '#666' }}>{scanStatusMessage}</div>
                  <div style={{ color: '#999', marginTop: 4, fontSize: 12 }}>
                    已等待 {elapsedSec} 秒
                  </div>
                </div>
              )}
            </div>
          )}

          {scanStatus === 'FAILED' && (
            <Alert
              type="error"
              showIcon
              icon={<CloseCircleOutlined />}
              message="掃描失敗"
              description={scanError ?? '請檢查 Edge 連線狀態與 Modbus 設備接線。'}
              style={{ marginBottom: 16 }}
            />
          )}
          {scanStatus === 'EXPIRED' && (
            <Alert
              type="warning"
              showIcon
              message="指令逾時"
              description="Edge 可能離線或未回應，請確認 Edge 狀態後重試。"
              style={{ marginBottom: 16 }}
            />
          )}

          {scanStatus === 'SUCCEEDED' && scanResults.length > 0 && (
            <>
              {scanResults.map((dev, i) => (
                <div key={i} style={{ marginBottom: 16 }}>
                  <Descriptions size="small" bordered column={4}>
                    <Descriptions.Item label="類型">{dev.device_type}</Descriptions.Item>
                    <Descriptions.Item label="Slave ID">{dev.slave_id}</Descriptions.Item>
                    <Descriptions.Item label="Bus">{dev.bus_id}</Descriptions.Item>
                    <Descriptions.Item label="狀態">
                      <Tag color={dev.online ? 'green' : 'red'}>
                        {dev.online ? '在線' : '離線'}
                      </Tag>
                    </Descriptions.Item>
                  </Descriptions>
                  {dev.circuits && dev.circuits.length > 0 && (
                    <Table
                      dataSource={dev.circuits}
                      rowKey="circuit"
                      size="small"
                      pagination={false}
                      style={{ marginTop: 8 }}
                      columns={[
                        { title: '迴路', dataIndex: 'circuit', key: 'circuit', width: 80 },
                        {
                          title: 'CT',
                          dataIndex: 'ct_pri',
                          key: 'ct',
                          render: (v: number) => (v ? `${v}A` : '--'),
                        },
                        {
                          title: '接線',
                          dataIndex: 'wire_type',
                          key: 'wire',
                          render: (v: string) => v || '--',
                        },
                        {
                          title: '量測值',
                          key: 'measurement',
                          render: (_: unknown, r: ScanCircuit) => {
                            if (!r.measurement) return '--';
                            return Object.entries(r.measurement)
                              .map(([k, v]) => `${k}: ${v.value} ${v.unit}`)
                              .join(' | ');
                          },
                        },
                      ]}
                    />
                  )}
                </div>
              ))}
            </>
          )}

          {scanStatus === 'SUCCEEDED' && scanResults.length === 0 && (
            <Text type="secondary">掃描完成，但未找到任何設備。</Text>
          )}
        </div>
      )}

      {wizardStep === 'confirm' && (
        <div>
          <Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
            勾選要建立的設備，可編輯設備名稱。確認後將寫入資料庫並下發配置指令給 Edge。
          </Text>
          {/* M-PM-138 fix3: D 區設備送電中但 Edge04 BusRuntime fc=3 timeout（wiring/baudrate/register addr）
              → online=false；不應 hard block 確認建立。允許老王勾選離線設備；Edge BusRuntime 後續 polling 自動重試 */}
          {confirmRows.some((r) => !r.online) && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              message={`${confirmRows.filter((r) => !r.online).length} 台設備離線（Edge BusRuntime timeout）`}
              description="設備送電但首次掃描通訊失敗（可能 RS-485 wiring / baudrate / slave_id / register addr 對應錯）；可仍勾選確認建立，Edge polling 將自動重試；P10 同步採證 RTU 通訊根因"
            />
          )}
          <Space style={{ marginBottom: 12 }}>
            <Checkbox
              checked={confirmRows.length > 0 && confirmRows.every((r) => r.checked)}
              indeterminate={
                confirmRows.some((r) => r.checked) && !confirmRows.every((r) => r.checked)
              }
              onChange={(e) => {
                const v = e.target.checked;
                setConfirmRows((prev) => prev.map((row) => ({ ...row, checked: v })));
              }}
            >
              全選（含離線）
            </Checkbox>
          </Space>
          <Table
            dataSource={confirmRows}
            rowKey={(r) => `${r.device_type}-${r.slave_id}-${r.bus_id}`}
            size="small"
            pagination={false}
            columns={[
              {
                title: '',
                key: 'check',
                width: 50,
                render: (_: unknown, r: ConfirmRow, idx: number) => (
                  // M-PM-138 fix3: 移除 disabled={!r.online}；允許老王勾選離線設備
                  // 對齊「D 區送電但 RTU timeout」實況；建立後 Edge BusRuntime polling 自動重試
                  <Checkbox
                    checked={r.checked}
                    onChange={(e) => {
                      setConfirmRows((prev) =>
                        prev.map((row, i) =>
                          i === idx ? { ...row, checked: e.target.checked } : row,
                        ),
                      );
                    }}
                  />
                ),
              },
              { title: '類型', dataIndex: 'device_type', key: 'type', width: 100 },
              { title: 'Slave', dataIndex: 'slave_id', key: 'slave', width: 70 },
              {
                title: '狀態',
                key: 'online',
                width: 80,
                render: (_: unknown, r: ConfirmRow) => (
                  <Tag color={r.online ? 'green' : 'red'}>{r.online ? '在線' : '離線'}</Tag>
                ),
              },
              {
                title: '迴路',
                key: 'circuits',
                width: 140,
                render: (_: unknown, r: ConfirmRow) =>
                  (r.circuits || [])
                    .filter((c) => c.configured)
                    .map((c) => c.circuit)
                    .join(', ') || '--',
              },
              {
                title: '設備名稱',
                key: 'name',
                render: (_: unknown, r: ConfirmRow, idx: number) => (
                  // M-PM-138 fix3: 移除 disabled={!r.online}；允許離線設備改名（與勾選邏輯一致）
                  <Input
                    size="small"
                    value={r.device_name}
                    onChange={(e) => {
                      setConfirmRows((prev) =>
                        prev.map((row, i) =>
                          i === idx ? { ...row, device_name: e.target.value } : row,
                        ),
                      );
                    }}
                  />
                ),
              },
            ]}
          />
        </div>
      )}
    </Modal>
  );
}
