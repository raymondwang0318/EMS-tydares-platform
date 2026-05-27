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
 * M-PM-277 調整（含 §二次迭代）：
 *   - 移除在線狀態 / 最後更新時間顯示
 *   - 下拉選單 → 4×4 固定按鈕格 TC01~TC16
 *   - 按鈕帶入 IR 標籤管理設定的安裝位置名稱（display_name 去除 -TCxx 後綴）
 *   - 在線=綠色, 離線=藍色, 選中=金色外框
 *   - 斷線後保留最後一張畫面（frames state 不清除）
 */
import { useEffect, useState, useCallback, useMemo } from 'react';
import { Button, Card, Spin, Typography } from 'antd';
import type { ThermalSummary } from '../models/thermal';
import { ThermalDisplay } from '../components/thermal/ThermalDisplay';
import { normalizeIrdata, computeSummary } from '../utils/thermalProcessor';
import { thermalSSEClient } from '../services/thermalSource';
import { useIrDevices } from '../hooks/useIrDevices';
import { useEdges } from '../hooks/useEdges';

const { Title } = Typography;

const TC_COUNT = 16;
const COLS = 4; // 4 欄 × 4 列

type FrameState = {
  deviceId: string;
  timestamp: string;
  image: string;
  irdata: string;
  shift: string;
  summary: ThermalSummary;
};

type TcButtonData = {
  num: number;
  deviceId: string | undefined;
  location: string; // display_name 去除 -TCxx 後綴（供操作人員辨識安裝場所）
  isOnline: boolean;
  isSelected: boolean;
};

export default function ThermalView() {
  const [frames, setFrames] = useState<Record<string, FrameState>>({});
  const [selectedDevice, setSelectedDevice] = useState<string | undefined>();

  const { data: irDevicesData } = useIrDevices();
  const { data: edgesData } = useEdges();

  /**
   * TC 編號 → { deviceId, location } 對應表
   * display_name 後綴規則：…-TC01 / …-TC16 等
   * location = display_name 去除 -TCxx 後綴，作為操作人員辨識安裝場所的名稱
   */
  const tcToInfo = useMemo(() => {
    const m = new Map<number, { deviceId: string; location: string }>();
    (irDevicesData ?? []).forEach((d) => {
      const dn = d.display_name ?? '';
      const match = dn.match(/TC(\d{1,2})$/i);
      if (match) {
        const num = parseInt(match[1], 10);
        const location = dn.replace(/-?TC\d{1,2}$/i, '').trim();
        m.set(num, { deviceId: d.device_id, location });
      }
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
   * 16 顆按鈕資料，4 欄排列
   */
  const tcButtons = useMemo<TcButtonData[]>(
    () =>
      Array.from({ length: TC_COUNT }, (_, i) => {
        const num = i + 1;
        const info = tcToInfo.get(num);
        const deviceId = info?.deviceId;
        const location = info?.location ?? '';
        const isOnline = !!deviceId && !!frames[deviceId];
        const isSelected = !!deviceId && selectedDevice === deviceId;
        return { num, deviceId, location, isOnline, isSelected };
      }),
    [tcToInfo, frames, selectedDevice],
  );

  const frame = selectedDevice ? frames[selectedDevice] : null;

  return (
    <Spin spinning={false}>
      <div style={{ marginBottom: 16 }}>
        <Title level={3} style={{ margin: 0 }}>
          熱力圖即時監控
        </Title>
      </div>

      {/* 4×4 固定按鈕格（M-PM-277：在線=綠, 離線=藍, 選中=金框；含安裝位置名稱） */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${COLS}, minmax(0, 1fr))`,
          gap: 8,
          marginBottom: 16,
        }}
      >
        {tcButtons.map(({ num, deviceId, location, isOnline, isSelected }) => {
          const tcCode = `TC${String(num).padStart(2, '0')}`;
          const bg = isOnline ? '#52c41a' : '#1677ff';
          return (
            <Button
              key={num}
              block
              onClick={() => deviceId && setSelectedDevice(deviceId)}
              disabled={!deviceId}
              style={{
                backgroundColor: bg,
                borderColor: isSelected ? '#faad14' : bg,
                color: '#fff',
                boxShadow: isSelected ? '0 0 0 2px #faad14' : undefined,
                opacity: deviceId ? 1 : 0.35,
                height: 'auto',
                padding: '6px 8px',
                textAlign: 'center',
                lineHeight: 1.3,
              }}
            >
              {/* TC 編號（粗體）+ 安裝位置名稱（小字） */}
              <div style={{ fontWeight: 700, fontSize: 13 }}>{tcCode}</div>
              {location && (
                <div style={{ fontSize: 11, opacity: 0.92, marginTop: 2, whiteSpace: 'normal', wordBreak: 'break-all' }}>
                  {location}
                </div>
              )}
            </Button>
          );
        })}
      </div>

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
