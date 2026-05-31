/**
 * 遠端 I/O 設定頁（M-PM-289 §B）
 *
 * 6 場域 tab（A3/A4/A8/B3/B4/C）× DI/DO 模組分組
 * 每點位：名稱設定 + DI 即時狀態 + DO 測試輸出（5 秒自動回 0）
 *
 * 點位名稱：localStorage 暫存（待 P12A 補 PATCH endpoint 後切真實 backend）
 * Backend ready endpoints：
 *   GET  /admin/io/devices?site_code=X       → 模組列表
 *   GET  /admin/io/devices/{id}/channels     → 16 ch 結構（靜態）
 *   GET  /admin/io/devices/{id}/status       → DI/DO 即時狀態（poll 3s）
 *   POST /admin/io/devices/{id}/channels/{ch}/control → DO 測試輸出
 */

import { useState, useRef, useCallback } from 'react';
import {
  Typography, Tabs, Table, Input, Button, Badge, Space, Alert, Spin, Tag
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  ControlOutlined, SaveOutlined, ThunderboltOutlined
} from '@ant-design/icons';
import { useQuery, useMutation } from '@tanstack/react-query';
import api from '../services/api';
import { SITE_CONFIGS } from '../constants/remoteIO';

const { Title, Text } = Typography;

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

interface IoDevice {
  device_id: string;
  device_kind: string;  // 'tcs300b03_di' | 'tcs300b04_do'
  edge_id: string;
  site_code: string;
  display_name: string | null;
}

interface ChannelDef {
  code: string;    // e.g. 'di_ch1'
  name: string;    // e.g. 'DI 1'
  category: string;
}

interface ChannelState {
  channel: number;
  state: 0 | 1;
}

interface DeviceStatusResp {
  device_id: string;
  channels: ChannelState[] | null;
  data_source: string;
}

interface ChannelRow {
  key: string;
  chNum: number;
  label: string;   // DI_01 / DO_01
  state: 0 | 1 | null;
  pending: boolean;
  customName: string;
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

// localStorage helpers for custom name (mock until P12A adds PATCH endpoint)
const nameKey = (deviceId: string, ch: number) => `io_name_${deviceId}_${ch}`;
const getLocalName = (deviceId: string, ch: number): string =>
  localStorage.getItem(nameKey(deviceId, ch)) ?? '';
const setLocalName = (deviceId: string, ch: number, name: string): void =>
  localStorage.setItem(nameKey(deviceId, ch), name);

// ─────────────────────────────────────────────────────────────
// DeviceGroup — one module (16 channels) with status + control
// ─────────────────────────────────────────────────────────────

function DeviceGroup({ device, enabled }: { device: IoDevice; enabled: boolean }) {
  const isDI = device.device_kind === 'tcs300b03_di';
  const moduleLabel = getModuleLabel(device.device_id);

  // Static channel definitions
  const { data: channelData } = useQuery({
    queryKey: ['io-channels', device.device_id],
    queryFn: () =>
      api.get<{ channels: ChannelDef[] }>(`/admin/io/devices/${device.device_id}/channels`)
        .then(r => r.data),
    enabled,
    staleTime: Infinity,
  });

  // Live status (polled every 3s)
  const { data: statusData } = useQuery({
    queryKey: ['io-status', device.device_id],
    queryFn: () =>
      api.get<DeviceStatusResp>(`/admin/io/devices/${device.device_id}/status`)
        .then(r => r.data),
    enabled,
    refetchInterval: 3000,
  });

  // Local name state (keyed by channel)
  const [localNames, setLocalNames] = useState<Record<number, string>>(() => {
    const init: Record<number, string> = {};
    for (let ch = 1; ch <= 16; ch++) {
      init[ch] = getLocalName(device.device_id, ch);
    }
    return init;
  });

  // DO control mutation + 5s auto-OFF timer
  const autoOffTimers = useRef<Record<number, ReturnType<typeof setTimeout>>>({});

  const controlMutation = useMutation({
    mutationFn: ({ ch, state }: { ch: number; state: boolean }) =>
      api.post(`/admin/io/devices/${device.device_id}/channels/${ch}/control`, {
        state,
        actor: 'admin',
        reason: state ? 'DO 測試輸出' : 'DO 測試自動回 0（5s）',
      }),
  });

  const handleDOTest = useCallback((ch: number) => {
    // Cancel any pending auto-OFF for this channel
    if (autoOffTimers.current[ch]) clearTimeout(autoOffTimers.current[ch]);

    controlMutation.mutate({ ch, state: true }, {
      onSuccess: () => {
        autoOffTimers.current[ch] = setTimeout(() => {
          controlMutation.mutate({ ch, state: false });
          delete autoOffTimers.current[ch];
        }, 5000);
      },
    });
  }, [controlMutation]);

  const handleSaveName = useCallback((ch: number) => {
    setLocalName(device.device_id, ch, localNames[ch] ?? '');
  }, [device.device_id, localNames]);

  // Build channel state lookup
  const stateMap: Record<number, 0 | 1> = {};
  if (statusData?.channels) {
    statusData.channels.forEach(c => { stateMap[c.channel] = c.state; });
  }
  const isPendingIngest = statusData?.data_source === 'pending_ingest' || !statusData?.channels;

  // Build rows from channel defs or fallback to 1-16
  const channels: ChannelDef[] = channelData?.channels ?? Array.from({ length: 16 }, (_, i) => ({
    code: isDI ? `di_ch${i + 1}` : `do_ch${i + 1}`,
    name: `${isDI ? 'DI' : 'DO'} ${i + 1}`,
    category: isDI ? 'digital_input' : 'digital_output',
  }));

  const rows: ChannelRow[] = channels.map(c => {
    const ch = parseChNum(c.code);
    return {
      key: c.code,
      chNum: ch,
      label: chLabel(isDI, ch),
      state: isPendingIngest ? null : (stateMap[ch] ?? null),
      pending: isPendingIngest,
      customName: localNames[ch] ?? '',
    };
  });

  const columns: ColumnsType<ChannelRow> = [
    {
      title: '點位',
      dataIndex: 'label',
      width: 90,
      render: (label: string) => <Text code style={{ fontSize: 12 }}>{label}</Text>,
    },
    {
      title: '名稱',
      dataIndex: 'customName',
      width: 200,
      render: (_: string, row: ChannelRow) => (
        <Input
          size="small"
          value={localNames[row.chNum] ?? ''}
          maxLength={30}
          placeholder={`${row.label} 名稱`}
          onChange={e => setLocalNames(prev => ({ ...prev, [row.chNum]: e.target.value }))}
          style={{ width: 160 }}
        />
      ),
    },
    {
      title: '儲存',
      width: 60,
      align: 'center',
      render: (_: unknown, row: ChannelRow) => (
        <Button
          size="small"
          icon={<SaveOutlined />}
          onClick={() => handleSaveName(row.chNum)}
          title="儲存名稱（暫存本機）"
        />
      ),
    },
    {
      title: '狀態',
      width: 80,
      align: 'center',
      render: (_: unknown, row: ChannelRow) => {
        if (row.state === null)
          return <Tag color="default" style={{ fontSize: 11 }}>待 ingest</Tag>;
        return row.state === 1
          ? <Badge status="success" text={<Text style={{ fontSize: 12 }}>ON</Text>} />
          : <Badge status="default" text={<Text type="secondary" style={{ fontSize: 12 }}>OFF</Text>} />;
      },
    },
    ...(!isDI ? [{
      title: '測試輸出',
      width: 100,
      align: 'center' as const,
      render: (_: unknown, row: ChannelRow) => (
        <Button
          size="small"
          type="primary"
          danger
          icon={<ThunderboltOutlined />}
          loading={controlMutation.isPending}
          onClick={() => handleDOTest(row.chNum)}
          title="送出 ON → 5 秒後自動回 OFF"
        >
          測試
        </Button>
      ),
    }] : []),
  ];

  return (
    <div style={{ marginBottom: 24 }}>
      <Space align="center" style={{ marginBottom: 8 }}>
        <Tag color={isDI ? 'blue' : 'orange'}>{isDI ? 'DI 輸入' : 'DO 輸出'}</Tag>
        <Text strong>{moduleLabel}</Text>
        <Text type="secondary" style={{ fontSize: 12 }}>{device.device_id}</Text>
      </Space>
      {!isDI && (
        <Alert
          type="warning"
          showIcon
          banner
          message="DO 測試輸出：點按後送出 ON，5 秒後自動回 OFF。請確認現場安全再操作。"
          style={{ marginBottom: 8 }}
        />
      )}
      <Table<ChannelRow>
        dataSource={rows}
        columns={columns}
        size="small"
        pagination={false}
        bordered
        style={{ fontSize: 12 }}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// SitePanel — one tab's content
// ─────────────────────────────────────────────────────────────

function SitePanel({ siteCode, enabled }: { siteCode: string; enabled: boolean }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['io-devices', siteCode],
    queryFn: () =>
      api.get<{ devices: IoDevice[]; total: number }>(`/admin/io/devices?site_code=${siteCode}`)
        .then(r => r.data),
    enabled,
    staleTime: 30_000,
  });

  if (!enabled) return null;
  if (isLoading) return <Spin tip="載入模組..." style={{ margin: 24 }} />;
  if (isError) return <Alert type="error" message={`無法載入 ${siteCode} 模組清單`} showIcon />;

  const devices = data?.devices ?? [];
  if (devices.length === 0) {
    return (
      <Alert
        type="info"
        showIcon
        message={`${siteCode} 場域尚無 DI/DO 模組（ScanWizard 掃描後才會出現）`}
      />
    );
  }

  // Sort by slave number
  const sorted = [...devices].sort((a, b) => getSlaveNum(a.device_id) - getSlaveNum(b.device_id));

  return (
    <div>
      {sorted.map(dev => (
        <DeviceGroup key={dev.device_id} device={dev} enabled={enabled} />
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// IOSettings — main page
// ─────────────────────────────────────────────────────────────

export default function IOSettings() {
  const [activeTab, setActiveTab] = useState<string>('A3');

  const tabItems = SITE_CONFIGS.map(site => ({
    key: site.code,
    label: site.name,
    children: <SitePanel siteCode={site.code} enabled={activeTab === site.code} />,
  }));

  return (
    <div>
      <Space direction="vertical" size={4} style={{ marginBottom: 16 }}>
        <Title level={3} style={{ margin: 0 }}>
          <ControlOutlined /> 遠端 I/O 設定
        </Title>
        <Text type="secondary">
          依場域設定 DI/DO 點位名稱；監看 DI 即時狀態；DO 測試輸出（5 秒自動回 OFF）
        </Text>
      </Space>

      <Alert
        type="info"
        showIcon
        message="點位名稱暫存本機"
        description="點位名稱儲存功能目前為本機暫存（localStorage）。後端 PATCH endpoint 補齊後將自動同步至伺服器（P12A 待補）。"
        style={{ marginBottom: 16 }}
        closable
      />

      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        destroyInactiveTabPane={false}
        items={tabItems}
        type="card"
      />
    </div>
  );
}
