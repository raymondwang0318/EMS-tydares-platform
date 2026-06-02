/**
 * 遠端 I/O 設定頁（M-PM-289 §B v2）
 *
 * 重設計：緊湊 2 欄 grid（DI_01~08 左 / DI_09~16 右）
 *         lamp 狀態圓點（綠=1 / 灰=0 / 待 ingest=虛線）
 *         Collapse 展開/收縮每模組
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import {
  Typography, Tabs, Collapse, Input, Button, Space, Alert, Spin, Tag, Tooltip, message
} from 'antd';
import { ControlOutlined, SaveOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { useQuery, useMutation } from '@tanstack/react-query';
import api from '../services/api';
import { SITE_CONFIGS } from '../constants/remoteIO';

const { Title, Text } = Typography;

// ─────────────────────────────────────────────────────────────
// 預設點位名稱（電路圖 2026-06-01 老王提供）
// key: `${slaveNum}_${chNum}`
// ─────────────────────────────────────────────────────────────

const _DI_SIGNAL = ['手動', '自動', '運轉', '過載'] as const;

const DEFAULT_CHANNEL_NAMES: Record<string, string> = {
  // DI Slave 1 (AX1~16)：負壓風扇 1-4
  ...Object.fromEntries(
    [1, 2, 3, 4].flatMap((fan, fi) =>
      _DI_SIGNAL.map((sig, si) => [`1_${fi * 4 + si + 1}`, `負壓風扇${fan} ${sig}`])
    )
  ),
  // DI Slave 2 (BX1~16)：負壓風扇 5-6 + 內循環風扇 1-2
  ...Object.fromEntries([
    ...[5, 6].flatMap((fan, fi) =>
      _DI_SIGNAL.map((sig, si) => [`2_${fi * 4 + si + 1}`, `負壓風扇${fan} ${sig}`])
    ),
    ...[1, 2].flatMap((fan, fi) =>
      _DI_SIGNAL.map((sig, si) => [`2_${(fi + 2) * 4 + si + 1}`, `內循環風扇${fan} ${sig}`])
    ),
  ]),
  // DI Slave 3 (CX1~4)：內循環風扇 3（ch5~16 留空）
  ...Object.fromEntries(
    _DI_SIGNAL.map((sig, si) => [`3_${si + 1}`, `內循環風扇3 ${sig}`])
  ),
  // DO Slave 4 (AY1~9)：負壓風扇 1-6 + 內循環風扇 1-3 自動起動
  ...Object.fromEntries([
    ...[1, 2, 3, 4, 5, 6].map((fan, i) => [`4_${i + 1}`, `負壓風扇${fan} 自動起動`]),
    ...[1, 2, 3].map((fan, i) => [`4_${i + 7}`, `內循環風扇${fan} 自動起動`]),
  ]),
};

const getDefaultName = (slaveNum: number, ch: number): string =>
  DEFAULT_CHANNEL_NAMES[`${slaveNum}_${ch}`] ?? '';

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

interface IoDevice {
  device_id: string;
  device_kind: string;
  edge_id: string;
  site_code: string;
  display_name: string | null;
}

interface ChannelDef {
  code: string;
  name: string;
  category: string;
  channel?: number | null;       // M-PM-293 §B：GET 回傳 channel 號
  custom_name?: string | null;   // M-PM-293 §B：業主自訂點位名稱（後端持久化）
}

interface ChannelState { channel: number; state: 0 | 1; }

interface DeviceStatusResp {
  device_id: string;
  channels: ChannelState[] | null;
  data_source: string;
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

const parseChNum = (code: string): number => {
  const m = code.match(/_ch(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
};

const chLabel = (isDI: boolean, ch: number): string =>
  `${isDI ? 'DI' : 'DO'}_${String(ch).padStart(2, '0')}`;

const getSlaveNum = (deviceId: string): number => {
  const m = deviceId.match(/-slave(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
};

const getModuleLabel = (deviceId: string): string => {
  const n = getSlaveNum(deviceId);
  if (deviceId.startsWith('tcs300b03-')) return `DI-${n} 模組（TCS300B03）`;
  if (deviceId.startsWith('tcs300b04-')) return `DO-${n} 模組（TCS300B04）`;
  return deviceId;
};

// 點位名稱初始值（M-PM-293 §B 切真實 API）：
//   後端 custom_name（業主已存）優先 → 否則電路圖預設名（DEFAULT_CHANNEL_NAMES）
// 儲存改打 PATCH /channels/{ch}（取代原 localStorage）

// ─────────────────────────────────────────────────────────────
// Lamp — status indicator
// ─────────────────────────────────────────────────────────────

function Lamp({ state }: { state: 0 | 1 | null }) {
  const color = state === 1 ? '#52c41a' : state === 0 ? '#d9d9d9' : 'transparent';
  const border = state === null ? '2px dashed #d9d9d9' : `2px solid ${color}`;
  return (
    <div style={{
      width: 12, height: 12, borderRadius: '50%',
      background: color, border,
      flexShrink: 0, marginTop: 1,
    }} />
  );
}

// ─────────────────────────────────────────────────────────────
// ChannelCell — one point row (compact)
// ─────────────────────────────────────────────────────────────

interface ChannelCellProps {
  chNum: number;
  isDI: boolean;
  state: 0 | 1 | null;
  localNames: Record<number, string>;
  setLocalNames: React.Dispatch<React.SetStateAction<Record<number, string>>>;
  onSave: (ch: number) => void;
  onDOTest: (ch: number) => void;
  doLoading: boolean;
  saveLoading: boolean;
}

function ChannelCell({
  chNum, isDI, state,
  localNames, setLocalNames, onSave, onDOTest, doLoading, saveLoading,
}: ChannelCellProps) {
  const label = chLabel(isDI, chNum);
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
      padding: '3px 6px', borderRadius: 4,
      background: '#fafafa', marginBottom: 3,
    }}>
      <Tooltip title={state === 1 ? 'ON' : state === 0 ? 'OFF' : '待 ingest'}>
        <span><Lamp state={state} /></span>
      </Tooltip>
      <Text code style={{ fontSize: 11, width: 42, flexShrink: 0 }}>{label}</Text>
      <Input
        size="small"
        value={localNames[chNum] ?? ''}
        maxLength={20}
        placeholder={`${label} 名稱`}
        onChange={e => setLocalNames(prev => ({ ...prev, [chNum]: e.target.value }))}
        style={{ flex: 1, fontSize: 12, minWidth: 80 }}
      />
      <Tooltip title="儲存名稱至伺服器">
        <Button
          size="small"
          icon={<SaveOutlined style={{ fontSize: 11 }} />}
          loading={saveLoading}
          onClick={() => onSave(chNum)}
          style={{ flexShrink: 0, padding: '0 4px' }}
        />
      </Tooltip>
      {!isDI && (
        <Tooltip title="送出 ON → 5 秒後自動回 OFF">
          <Button
            size="small"
            type="primary"
            danger
            icon={<ThunderboltOutlined style={{ fontSize: 11 }} />}
            loading={doLoading}
            onClick={() => onDOTest(chNum)}
            style={{ flexShrink: 0, padding: '0 4px' }}
          />
        </Tooltip>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// DeviceGroup — one module with 2-column layout + collapse
// ─────────────────────────────────────────────────────────────

function DeviceGroup({ device, enabled }: { device: IoDevice; enabled: boolean }) {
  const isDI = device.device_kind === 'tcs300b03_di';
  const moduleLabel = getModuleLabel(device.device_id);

  const { data: channelData } = useQuery({
    queryKey: ['io-channels', device.device_id],
    queryFn: () =>
      api.get<{ channels: ChannelDef[] }>(`/admin/io/devices/${device.device_id}/channels`)
        .then(r => r.data),
    enabled,
    staleTime: Infinity,
  });

  const { data: statusData } = useQuery({
    queryKey: ['io-status', device.device_id],
    queryFn: () =>
      api.get<DeviceStatusResp>(`/admin/io/devices/${device.device_id}/status`)
        .then(r => r.data),
    enabled,
    refetchInterval: 3000,
  });

  const slaveNum = getSlaveNum(device.device_id);
  const [localNames, setLocalNames] = useState<Record<number, string>>({});

  // 種子：channelData 載入後，以後端 custom_name（已存）優先 → 否則電路圖預設名
  // seededRef 確保只種一次，不覆蓋業主正在編輯的內容
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current || !channelData?.channels) return;
    const init: Record<number, string> = {};
    for (const c of channelData.channels) {
      const ch = c.channel ?? parseChNum(c.code);
      if (ch >= 1 && ch <= 16) init[ch] = c.custom_name ?? getDefaultName(slaveNum, ch);
    }
    setLocalNames(init);
    seededRef.current = true;
  }, [channelData, slaveNum]);

  const autoOffTimers = useRef<Record<number, ReturnType<typeof setTimeout>>>({});
  const [doLoadingCh, setDoLoadingCh] = useState<number | null>(null);
  const [savingCh, setSavingCh] = useState<number | null>(null);

  // M-PM-293 §B：儲存點位名稱 → PATCH /channels/{ch}（取代 localStorage）
  const saveMutation = useMutation({
    mutationFn: ({ ch, name }: { ch: number; name: string }) =>
      api.patch(`/admin/io/devices/${device.device_id}/channels/${ch}`, {
        custom_name: name.trim() || null,
      }),
  });

  const controlMutation = useMutation({
    mutationFn: ({ ch, state }: { ch: number; state: boolean }) =>
      api.post(`/admin/io/devices/${device.device_id}/channels/${ch}/control`, {
        state, actor: 'admin',
        reason: state ? 'DO 測試輸出' : 'DO 測試自動回 0（5s）',
      }),
  });

  const handleDOTest = useCallback((ch: number) => {
    if (autoOffTimers.current[ch]) clearTimeout(autoOffTimers.current[ch]);
    setDoLoadingCh(ch);
    controlMutation.mutate({ ch, state: true }, {
      onSettled: () => setDoLoadingCh(null),
      onSuccess: () => {
        autoOffTimers.current[ch] = setTimeout(() => {
          controlMutation.mutate({ ch, state: false });
          delete autoOffTimers.current[ch];
        }, 5000);
      },
    });
  }, [controlMutation]);

  const handleSaveName = useCallback((ch: number) => {
    setSavingCh(ch);
    saveMutation.mutate({ ch, name: localNames[ch] ?? '' }, {
      onSettled: () => setSavingCh(null),
      onSuccess: () => message.success(`${chLabel(isDI, ch)} 名稱已儲存`),
      onError: () => message.error(`${chLabel(isDI, ch)} 儲存失敗`),
    });
  }, [saveMutation, localNames, isDI]);

  // Build state map
  const stateMap: Record<number, 0 | 1> = {};
  if (statusData?.channels) {
    statusData.channels.forEach(c => { stateMap[c.channel] = c.state; });
  }
  const isPending = !statusData?.channels || statusData.data_source === 'pending_ingest';

  // Build channel list
  const channels = channelData?.channels ?? Array.from({ length: 16 }, (_, i) => ({
    code: isDI ? `di_ch${i + 1}` : `do_ch${i + 1}`,
    name: `${isDI ? 'DI' : 'DO'} ${i + 1}`,
    category: isDI ? 'digital_input' : 'digital_output',
  }));

  // Split into two columns: ch 1~8 (left), 9~16 (right)
  const allChs = channels.map(c => parseChNum(c.code));
  const leftChs = allChs.filter(n => n <= 8);
  const rightChs = allChs.filter(n => n > 8);

  const cellProps = (ch: number) => ({
    chNum: ch,
    isDI,
    state: isPending ? null : (stateMap[ch] ?? null) as 0 | 1 | null,
    localNames,
    setLocalNames,
    onSave: handleSaveName,
    onDOTest: handleDOTest,
    doLoading: doLoadingCh === ch,
    saveLoading: savingCh === ch,
  });

  // Collapse header with lamp summary
  const onCount = isPending ? '–' : Object.values(stateMap).filter(v => v === 1).length;
  const collapseLabel = (
    <Space size={8}>
      <Tag color={isDI ? 'blue' : 'orange'} style={{ marginRight: 0 }}>{isDI ? 'DI 輸入' : 'DO 輸出'}</Tag>
      <Text strong style={{ fontSize: 13 }}>{moduleLabel}</Text>
      <Text type="secondary" style={{ fontSize: 11 }}>{device.device_id}</Text>
      {!isPending && (
        <Text style={{ fontSize: 11 }}>
          <span style={{ color: '#52c41a' }}>●</span> {onCount} ON
        </Text>
      )}
      {isPending && <Tag color="default" style={{ fontSize: 11 }}>待 ingest</Tag>}
    </Space>
  );

  return (
    <Collapse
      defaultActiveKey={[]}
      size="small"
      style={{ marginBottom: 12 }}
      items={[{
        key: 'module',
        label: collapseLabel,
        children: (
          <div>
            {!isDI && (
              <Alert
                type="warning"
                showIcon
                banner
                message="DO 測試：點按 ⚡ 送出 ON，5 秒後自動回 OFF。請確認現場安全。"
                style={{ marginBottom: 8, fontSize: 12 }}
              />
            )}
            {/* 2-column grid */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
              <div>{leftChs.map(ch => <ChannelCell key={ch} {...cellProps(ch)} />)}</div>
              <div>{rightChs.map(ch => <ChannelCell key={ch} {...cellProps(ch)} />)}</div>
            </div>
          </div>
        ),
      }]}
    />
  );
}

// ─────────────────────────────────────────────────────────────
// SitePanel
// ─────────────────────────────────────────────────────────────

function SitePanel({ siteCode, enabled }: { siteCode: string; enabled: boolean }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['io-devices', siteCode],
    queryFn: () =>
      api.get<{ devices: IoDevice[] }>(`/admin/io/devices?site_code=${siteCode}`)
        .then(r => r.data),
    enabled,
    staleTime: 30_000,
  });

  if (!enabled) return null;
  if (isLoading) return <Spin tip="載入模組..." style={{ margin: 24 }} />;
  if (isError) return <Alert type="error" message={`無法載入 ${siteCode} 模組清單`} showIcon />;

  const devices = [...(data?.devices ?? [])].sort(
    (a, b) => getSlaveNum(a.device_id) - getSlaveNum(b.device_id)
  );

  if (devices.length === 0) {
    return (
      <Alert
        type="info"
        showIcon
        message={`${siteCode} 場域尚無 DI/DO 模組（請先執行 ScanWizard）`}
      />
    );
  }

  return (
    <div>
      {devices.map(dev => <DeviceGroup key={dev.device_id} device={dev} enabled={enabled} />)}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// IOSettings — main page
// ─────────────────────────────────────────────────────────────

export default function IOSettings() {
  const [activeTab, setActiveTab] = useState<string>('A3');

  return (
    <div>
      <Space direction="vertical" size={2} style={{ marginBottom: 12 }}>
        <Title level={3} style={{ margin: 0 }}>
          <ControlOutlined /> 遠端 I/O 設定
        </Title>
        <Text type="secondary" style={{ fontSize: 12 }}>
          依場域設定 DI/DO 點位名稱；監看 DI 即時狀態；DO 測試輸出（5 秒自動回 OFF）
        </Text>
      </Space>

      <Alert
        type="info"
        showIcon
        message="點位名稱已連動伺服器"
        description="點位名稱儲存至後端（ems_device_channel_metadata），Boss 可透過 API 查詢。預設帶入電路圖名稱，可編輯後按儲存覆蓋。"
        style={{ marginBottom: 12 }}
        closable
      />

      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        type="card"
        size="small"
        items={SITE_CONFIGS.map(site => ({
          key: site.code,
          label: site.name,
          children: <SitePanel siteCode={site.code} enabled={activeTab === site.code} />,
        }))}
      />
    </div>
  );
}
