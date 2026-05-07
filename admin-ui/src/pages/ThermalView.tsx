/**
 * 811C 即時熱像監控頁（M-PM-107 軌 1 frontend 遷移；遷自 platform-UI legacy）
 *
 * Route: `/admin-ui/thermal/all`（M-PM-104 §2.2 採完整 JPEG + 熱力圖路徑；M-P10-028 image base64 已恢復）
 *
 * 功能：
 * - SSE 即時 frame 流入（GET /stream/811c；nginx port 8080 proxy → Pi）
 * - 7 顆 811C 連網設備自動列入 device 下拉
 * - 完整 JPEG 底圖 + 半透明 IR 8×8 熱力圖疊加 + 最高溫十字標記
 * - 對齊 admin-ui IR 標籤頁 display_name（如有則顯示；無則 device_id）
 */
import { useEffect, useState, useCallback, useMemo } from 'react';
import { Card, Tag, Typography, Spin, Badge, Select, Space } from 'antd';
import type { ThermalSummary } from '../models/thermal';
import { ThermalDisplay } from '../components/thermal/ThermalDisplay';
import { normalizeIrdata, computeSummary } from '../utils/thermalProcessor';
import { thermalSSEClient } from '../services/thermalSource';
import { useIrDevices, irDisplayLabel } from '../hooks/useIrDevices';
import { useEdges } from '../hooks/useEdges';

const { Title, Text } = Typography;

type FrameState = {
  deviceId: string;
  timestamp: string;
  image: string;
  irdata: string;
  shift: string;
  summary: ThermalSummary;
};

const EDGE_VIA_CENTRAL = '__central__';

export default function ThermalView() {
  // M-PM-158 multi-edge：Edge selector 切 SSE 來源
  // - 'central' (default) → 走 nginx `/stream/811c` proxy（hardcoded → E66；M-PM-133 §3.2 single-edge backcompat）
  // - 個別 edge_id → 直連 Edge LAN `http://{last_seen_ip}:8080/stream/811c`（CORS 已驗 ACAO=*）
  // 採證 M-PM-158 §2.3：Edge04 SSE GET 帶 Origin → 200 + ACAO * → CORS 不阻塞
  const [selectedEdge, setSelectedEdge] = useState<string>(EDGE_VIA_CENTRAL);
  const [frames, setFrames] = useState<Record<string, FrameState>>({});
  const [selectedDevice, setSelectedDevice] = useState<string | undefined>();
  const [lastUpdate, setLastUpdate] = useState('');
  const [connected, setConnected] = useState(false);

  // 對齊 admin-ui IR 標籤頁的 display_name
  const { data: irDevicesData } = useIrDevices();
  const { data: edgesData } = useEdges();
  const irNameMap = useMemo(() => {
    const m = new Map<string, string>();
    (irDevicesData ?? []).forEach((d, idx) => {
      m.set(d.device_id, irDisplayLabel(d, idx));
    });
    return m;
  }, [irDevicesData]);

  // M-PM-158 active edges 為 Edge selector 選項（approved / maintenance；含 hostname for tooltip）
  const edgeOptions = useMemo(() => {
    const active = (edgesData ?? []).filter(
      (e) => e.status === 'approved' || e.status === 'maintenance',
    );
    return [
      {
        value: EDGE_VIA_CENTRAL,
        label: '全部 Edge（透過 Central nginx）',
      },
      ...active.map((e) => ({
        value: e.edge_id,
        label: `${e.edge_id}${e.hostname ? ` · ${e.hostname}` : ''}${e.last_seen_ip ? ` (${e.last_seen_ip})` : ''}`,
      })),
    ];
  }, [edgesData]);

  // M-PM-158 dynamic SSE base URL：依 selectedEdge 切換
  const sseBaseUrl = useMemo(() => {
    if (selectedEdge === EDGE_VIA_CENTRAL) {
      // 同 origin → nginx /stream/811c proxy（hardcoded E66 backcompat）
      return (import.meta.env.VITE_THERMAL_SSE_URL as string | undefined)
        ?? (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/v\d+$/, '')
        ?? '';
    }
    // 直連特定 Edge LAN
    const edge = (edgesData ?? []).find((e) => e.edge_id === selectedEdge);
    if (!edge?.last_seen_ip) return '';
    return `http://${edge.last_seen_ip}:8080`;
  }, [selectedEdge, edgesData]);

  const handleFrame = useCallback(
    (sseFrame: { device_id: string; ts: string; image?: string; irdata: string; shift: string }) => {
      // ThermalView legacy line 27-28 既有 guard 直接適用（M-PM-104 §2.2 撤 fallback；走完整 JPEG 路徑）
      if (!sseFrame.image) return;

      const state: FrameState = {
        deviceId: sseFrame.device_id,
        timestamp: sseFrame.ts,
        image: sseFrame.image,
        irdata: sseFrame.irdata,
        shift: sseFrame.shift || '0,0',
        summary: computeSummary(normalizeIrdata(sseFrame.irdata)),
      };

      setFrames((prev) => ({ ...prev, [sseFrame.device_id]: state }));
      setLastUpdate(new Date().toLocaleString('zh-TW'));

      // 自動選第一台
      setSelectedDevice((prev) => prev || sseFrame.device_id);
    },
    [],
  );

  // M-PM-158 切 Edge 時：reset frame state（避免顯示舊 Edge 的 frame）
  useEffect(() => {
    setFrames({});
    setSelectedDevice(undefined);
    setLastUpdate('');
  }, [selectedEdge]);

  useEffect(() => {
    if (!sseBaseUrl && selectedEdge !== EDGE_VIA_CENTRAL) {
      // selected edge 但 last_seen_ip 為 null（offline 或未 enroll）→ 不嘗試連
      console.warn('[ThermalView] selected edge has no last_seen_ip; SSE not connected', selectedEdge);
      thermalSSEClient.disconnect();
      setConnected(false);
      return;
    }

    thermalSSEClient.connect(sseBaseUrl);

    const checkInterval = setInterval(() => {
      setConnected(thermalSSEClient.isConnected);
    }, 2000);

    const unsub = thermalSSEClient.onFrame(handleFrame);

    return () => {
      clearInterval(checkInterval);
      unsub();
      thermalSSEClient.disconnect();
    };
  }, [sseBaseUrl, selectedEdge, handleFrame]);

  const deviceList = Object.keys(frames);
  const frame = selectedDevice ? frames[selectedDevice] : null;

  const deviceOptions = deviceList.map((id) => ({
    value: id,
    label: irNameMap.get(id) ?? id,
  }));

  return (
    <Spin spinning={false}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 16,
        }}
      >
        <Title level={3} style={{ margin: 0 }}>
          熱力圖即時監控
        </Title>
        <Badge
          status={connected ? 'success' : 'error'}
          text={
            <Text type="secondary" style={{ fontSize: 12 }}>
              SSE {connected ? '已連線' : '未連線'}
            </Text>
          }
        />
      </div>

      <Space style={{ marginBottom: 16 }} wrap>
        {/* M-PM-158 multi-edge SSE Edge selector */}
        <Select
          style={{ width: 320 }}
          value={selectedEdge}
          onChange={setSelectedEdge}
          options={edgeOptions}
          placeholder="選擇 Edge"
        />
        <Select
          style={{ width: 360 }}
          placeholder="選擇 811C 設備"
          value={selectedDevice}
          onChange={setSelectedDevice}
          options={deviceOptions}
          notFoundContent="等待 SSE 串流"
        />
        <Text type="secondary" style={{ fontSize: 12 }}>
          {deviceList.length} 台上線
        </Text>
        {lastUpdate && <Tag color="green">最後更新: {lastUpdate}</Tag>}
      </Space>

      {frame ? (
        <Card size="small" styles={{ body: { padding: 0, overflow: 'hidden' } }}>
          <ThermalDisplay
            image={frame.image}
            irdata={frame.irdata}
            shift={frame.shift}
            summary={frame.summary}
          />
        </Card>
      ) : (
        <Card>
          <div style={{ textAlign: 'center', padding: 48, color: '#999' }}>
            等待 811C SSE 串流資料...
          </div>
        </Card>
      )}
    </Spin>
  );
}
