/**
 * 811C 即時熱像監控頁
 *
 * Route: `/admin-ui/thermal/all`
 *
 * 設計原則（老王 5/7 chat M-PM-158 校正）：
 *   - 「811C 不要綁死在某一顆 Edge 上面」 — IR 設備可漂移，UI 不認 edge_id
 *   - 「存活判定認 MAC + 安裝位置標籤」 — device_id（MAC）為主鍵，display_name 為人讀
 *
 * 實作（multi-edge fan-in）：
 *   - useEdges() 列所有 active edges → 對每顆 Edge 直連 SSE（CORS ACAO=* 已驗）
 *   - 多 SSE 同時聚合 frame；以 device_id 為索引
 *   - 不顯示 Edge 來源；列出所有看到 frame 的 IR + display_name 作辨識
 *   - 老王在 IR 標籤管理頁改 display_name → 此處下拉同步（safe sort + idle filter）
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

export default function ThermalView() {
  const [frames, setFrames] = useState<Record<string, FrameState>>({});
  const [selectedDevice, setSelectedDevice] = useState<string | undefined>();
  const [lastUpdate, setLastUpdate] = useState('');
  const [activeConnections, setActiveConnections] = useState(0);
  const [totalConnections, setTotalConnections] = useState(0);

  // 對齊 admin-ui IR 標籤頁的 display_name（安裝位置標籤）
  const { data: irDevicesData } = useIrDevices();
  const { data: edgesData } = useEdges();

  const irNameMap = useMemo(() => {
    const m = new Map<string, string>();
    (irDevicesData ?? []).forEach((d, idx) => {
      m.set(d.device_id, irDisplayLabel(d, idx));
    });
    return m;
  }, [irDevicesData]);

  // M-PM-158 multi-edge fan-in：所有 active edges 的 SSE base URL
  // active = approved / maintenance；用 last_seen_ip LAN 直連（CORS ACAO=* 已驗）
  const sseBaseUrls = useMemo(() => {
    const active = (edgesData ?? []).filter(
      (e) => (e.status === 'approved' || e.status === 'maintenance') && e.last_seen_ip,
    );
    return active.map((e) => `http://${e.last_seen_ip}:8080`);
  }, [edgesData]);

  const handleFrame = useCallback(
    (sseFrame: { device_id: string; ts: string; image?: string; irdata: string; shift: string }) => {
      // legacy guard：無 image 不渲染（M-PM-104 §2.2 撤 fallback；走完整 JPEG 路徑）
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
    if (sseBaseUrls.length === 0) return;

    thermalSSEClient.connectMulti(sseBaseUrls);

    const checkInterval = setInterval(() => {
      setActiveConnections(thermalSSEClient.activeConnectionCount);
      setTotalConnections(thermalSSEClient.totalConnectionCount);
    }, 2000);

    const unsub = thermalSSEClient.onFrame(handleFrame);

    return () => {
      clearInterval(checkInterval);
      unsub();
      thermalSSEClient.disconnect();
    };
  }, [sseBaseUrls, handleFrame]);

  // 設備清單：聯集（所有看過 frame 的 device_id + 所有已標記的 IR 設備）
  // 設計：device_id 是 MAC（主鍵）；display_name 是安裝位置標籤（人讀辨識）
  const allDeviceIds = useMemo(() => {
    const ids = new Set<string>();
    Object.keys(frames).forEach((id) => ids.add(id));
    (irDevicesData ?? []).forEach((d) => ids.add(d.device_id));
    return Array.from(ids).sort();
  }, [frames, irDevicesData]);

  const deviceOptions = allDeviceIds.map((id) => {
    const hasFrame = !!frames[id];
    const label = irNameMap.get(id) ?? id;
    return {
      value: id,
      label: (
        <Space size={4}>
          <Tag color={hasFrame ? 'green' : 'default'} style={{ marginRight: 0 }}>
            {hasFrame ? '在線' : '離線'}
          </Tag>
          <span>{label}</span>
        </Space>
      ),
    };
  });

  const frame = selectedDevice ? frames[selectedDevice] : null;
  const onlineCount = Object.keys(frames).length;

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
          status={activeConnections > 0 ? 'success' : 'error'}
          text={
            <Text type="secondary" style={{ fontSize: 12 }}>
              SSE {activeConnections}/{totalConnections} Edge 連線中
            </Text>
          }
        />
      </div>

      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          style={{ width: 360 }}
          placeholder="選擇 811C 設備（依安裝位置標籤）"
          value={selectedDevice}
          onChange={setSelectedDevice}
          options={deviceOptions}
          notFoundContent="等待 SSE 串流"
          showSearch
          optionFilterProp="label"
          // antd Select 的 label 是 React node 時 search 用 children；用 filterOption 自定
          filterOption={(input, option) => {
            const v = option?.value as string | undefined;
            const name = (v && irNameMap.get(v)) || v || '';
            return name.toLowerCase().includes(input.toLowerCase());
          }}
        />
        <Text type="secondary" style={{ fontSize: 12 }}>
          {onlineCount} / {allDeviceIds.length} 台在線
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
            {activeConnections === 0
              ? '正在連接 Edge SSE...'
              : '等待 811C SSE 串流資料... (尚未收到對應 device 的 frame)'}
          </div>
        </Card>
      )}
    </Spin>
  );
}
