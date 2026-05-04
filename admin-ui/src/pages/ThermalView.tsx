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

const { Title, Text } = Typography;

type FrameState = {
  deviceId: string;
  timestamp: string;
  image: string;
  irdata: string;
  shift: string;
  summary: ThermalSummary;
};

export default function ThermalView() {
  const [frames, setFrames] = useState<Record<string, FrameState>>({});
  const [selectedDevice, setSelectedDevice] = useState<string | undefined>();
  const [lastUpdate, setLastUpdate] = useState('');
  const [connected, setConnected] = useState(false);

  // 對齊 admin-ui IR 標籤頁的 display_name
  const { data: irDevicesData } = useIrDevices();
  const irNameMap = useMemo(() => {
    const m = new Map<string, string>();
    (irDevicesData ?? []).forEach((d, idx) => {
      m.set(d.device_id, irDisplayLabel(d, idx));
    });
    return m;
  }, [irDevicesData]);

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

  useEffect(() => {
    // baseUrl 用空字串（同 origin /stream/811c；nginx port 8080 已 proxy → 192.168.10.180:8080 Pi）
    const baseUrl = (import.meta.env.VITE_THERMAL_SSE_URL as string | undefined)
      ?? (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/v\d+$/, '')
      ?? '';

    thermalSSEClient.connect(baseUrl);

    const checkInterval = setInterval(() => {
      setConnected(thermalSSEClient.isConnected);
    }, 2000);

    const unsub = thermalSSEClient.onFrame(handleFrame);

    return () => {
      clearInterval(checkInterval);
      unsub();
      thermalSSEClient.disconnect();
    };
  }, [handleFrame]);

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
