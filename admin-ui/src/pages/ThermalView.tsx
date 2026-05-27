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
 *   - 不顯示 Edge 來源；16 顆固定按鈕 TC01~TC16（M-PM-277）
 *
 * M-PM-277 調整：
 *   - 移除在線狀態 / 最後更新時間顯示
 *   - 下拉選單 → 16 顆固定按鈕 TC01~TC16
 *   - 在線=綠色, 離線=藍色, 選中=金色外框
 *   - 斷線後保留最後一張畫面（frames state 不清除）
 */
import { useEffect, useState, useCallback, useMemo } from 'react';
import { Button, Card, Space, Spin, Typography } from 'antd';
import type { ThermalSummary } from '../models/thermal';
import { ThermalDisplay } from '../components/thermal/ThermalDisplay';
import { normalizeIrdata, computeSummary } from '../utils/thermalProcessor';
import { thermalSSEClient } from '../services/thermalSource';
import { useIrDevices } from '../hooks/useIrDevices';
import { useEdges } from '../hooks/useEdges';

const { Title } = Typography;

const TC_COUNT = 16;

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

  // 對齊 admin-ui IR 標籤頁的 display_name（安裝位置標籤）
  const { data: irDevicesData } = useIrDevices();
  const { data: edgesData } = useEdges();

  /**
   * TC 編號 → device_id 對應表
   * display_name 後綴規則：…-TC01 / …-TC16 等
   */
  const tcToDeviceId = useMemo(() => {
    const m = new Map<number, string>();
    (irDevicesData ?? []).forEach((d) => {
      const match = (d.display_name ?? '').match(/TC(\d{1,2})$/i);
      if (match) m.set(parseInt(match[1], 10), d.device_id);
    });
    return m;
  }, [irDevicesData]);

  // M-PM-158 multi-edge fan-in：所有 active edges 的 SSE base URL
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

      // 斷線後保留最後一張：frames 只增不清（M-PM-277）
      setFrames((prev) => ({ ...prev, [sseFrame.device_id]: state }));

      // 自動選第一台
      setSelectedDevice((prev) => prev || sseFrame.device_id);
    },
    [],
  );

  useEffect(() => {
    if (sseBaseUrls.length === 0) return;

    thermalSSEClient.connectMulti(sseBaseUrls);
    const unsub = thermalSSEClient.onFrame(handleFrame);

    return () => {
      unsub();
      thermalSSEClient.disconnect();
    };
  }, [sseBaseUrls, handleFrame]);

  /**
   * 16 顆固定按鈕資料（M-PM-277）
   * - isOnline：frames 中有該 device_id = 曾接收過 frame（SSE 推送中或斷線後保留）
   * - isSelected：當前選中
   */
  const tcButtons = useMemo(
    () =>
      Array.from({ length: TC_COUNT }, (_, i) => {
        const num = i + 1;
        const deviceId = tcToDeviceId.get(num);
        const isOnline = !!deviceId && !!frames[deviceId];
        const isSelected = !!deviceId && selectedDevice === deviceId;
        return { num, deviceId, isOnline, isSelected };
      }),
    [tcToDeviceId, frames, selectedDevice],
  );

  const frame = selectedDevice ? frames[selectedDevice] : null;

  return (
    <Spin spinning={false}>
      <div style={{ marginBottom: 16 }}>
        <Title level={3} style={{ margin: 0 }}>
          熱力圖即時監控
        </Title>
      </div>

      {/* 16 顆固定 TC 按鈕（M-PM-277：在線=綠, 離線=藍, 選中=金框） */}
      <Space wrap style={{ marginBottom: 16 }}>
        {tcButtons.map(({ num, deviceId, isOnline, isSelected }) => {
          const label = `TC${String(num).padStart(2, '0')}`;
          const bg = isOnline ? '#52c41a' : '#1677ff';
          return (
            <Button
              key={num}
              size="small"
              onClick={() => deviceId && setSelectedDevice(deviceId)}
              disabled={!deviceId}
              style={{
                backgroundColor: bg,
                borderColor: isSelected ? '#faad14' : bg,
                color: '#fff',
                fontWeight: isSelected ? 700 : 400,
                boxShadow: isSelected ? '0 0 0 2px #faad14' : undefined,
                opacity: deviceId ? 1 : 0.35,
                minWidth: 54,
              }}
            >
              {label}
            </Button>
          );
        })}
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
            {sseBaseUrls.length === 0
              ? '正在連接 Edge SSE...'
              : '等待 811C SSE 串流資料... (尚未收到對應 device 的 frame)'}
          </div>
        </Card>
      )}
    </Spin>
  );
}
