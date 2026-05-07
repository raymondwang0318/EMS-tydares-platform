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
  useEdgeDevices,
  type CommandStatus,
  type ConfirmDevice,
  type EmsDevice,
  type ScanCircuit,
  type ScanDevice,
} from '../hooks/useScanWizard';

const { Text } = Typography;

const DEVICE_TYPES = [
  { value: 'cpm12d', label: 'CPM-12D' },
  { value: 'cpm23', label: 'CPM-23' },
  { value: 'aem_drb', label: 'AEM-DRB' },
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
    const KNOWN_TYPES = ['cpm12d', 'cpm23', 'aem_drb', 'tcs300b03'];
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
      stopPolling();
      onClose();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      const detail = e?.response?.data?.detail ?? e?.message ?? '未知錯誤';
      message.error(`確認建立失敗：${detail}`);
    }
  };

  const closeModal = () => {
    stopPolling();
    onClose();
  };

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
