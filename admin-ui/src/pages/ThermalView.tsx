/**
 * 811C 即時熱像監控頁
 *
 * Route: `/admin-ui/thermal/all`
 *
 * 設計原則（老王 5/7 chat M-PM-158 校正）：
 *   - 「811C 不要綁死在某一顆 Edge 上面」 — IR 設備可漂移，UI 不認 edge_id
 *   - 「存活判定認 MAC + 安裝位置標籤」 — device_id（MAC）為主鍵，display_name 為人讀
 *
 * M-PM-277 調整：
 *   - 移除在線狀態 / 最後更新時間顯示
 *   - 下拉選單 → 4×4 固定按鈕格 TC01~TC16（含安裝位置名稱）
 *   - 在線=綠色, 離線=藍色（15s 無 frame = 離線）, 選中=金色外框
 *   - 斷線後保留最後一張（三層快取）：
 *     - sessionStorage：跨 hard reload 持久化；QuotaExceededError 靜默忽略
 *     - _frameCache：模組層級快取，component unmount/remount 不清除；
 *       module 載入時從 sessionStorage 恢復
 *     - frames state：優先，初始化從 _frameCache 載入
 *     - 顯示時 fallback → _frameCache（解決 state 重置導致白底問題）
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
const COLS = 4;

/** 超過此時間（ms）未收到 frame → 視為離線（按鈕轉藍） */
const ONLINE_STALE_MS = 15_000;

/** sessionStorage 鍵前綴 — 持久化各設備最後一張 frame，跨 hard reload */
const SS_PREFIX = 'thermal_frame_';
const SS_SELECTED = 'thermal_selected';

type FrameState = {
  deviceId: string;
  timestamp: string;
  image: string;
  irdata: string;
  shift: string;
  summary: ThermalSummary;
  /** 收到此 frame 的本機時間（Date.now()）；用於在線狀態判斷 */
  receivedAt: number;
};

type TcButtonData = {
  num: number;
  deviceId: string | undefined;
  location: string;
  isOnline: boolean;
  isSelected: boolean;
};

/**
 * 模組層級 frame 快取 — 對抗 React state 重置
 *
 * component unmount/remount（頁面切換）時 React state 會清空；
 * 模組層級變數在 JS module 生命週期內不清除。
 * 下次 mount 時以此快取初始化 state，確保畫面不白底。
 *
 * module 載入時從 sessionStorage 恢復，確保 hard reload 後仍能顯示最後一張。
 */
const _frameCache: Record<string, FrameState> = {};
let _lastSelected: string | undefined;

// module 載入時立即從 sessionStorage 恢復 — 確保 hard reload 後畫面不白底
;(function restoreFromStorage() {
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(SS_PREFIX)) {
        const raw = sessionStorage.getItem(key);
        if (raw) {
          const state = JSON.parse(raw) as FrameState;
          _frameCache[key.slice(SS_PREFIX.length)] = state;
        }
      }
    }
    _lastSelected = sessionStorage.getItem(SS_SELECTED) ?? undefined;
  } catch {
    // sessionStorage 不可用（私密模式 / 容量超限）— 靜默忽略
  }
})();

/** 將單一設備的 frame 寫入 sessionStorage（QuotaExceededError 靜默忽略） */
function saveFrameToStorage(deviceId: string, state: FrameState): void {
  try {
    sessionStorage.setItem(`${SS_PREFIX}${deviceId}`, JSON.stringify(state));
  } catch {
    // QuotaExceededError — 靜默忽略，不影響 runtime 功能
  }
}

export default function ThermalView() {
  // 初始化從模組快取載入（保留最後一張畫面；_frameCache 已在 module 載入時從 sessionStorage 恢復）
  const [frames, setFrames] = useState<Record<string, FrameState>>(() => ({ ..._frameCache }));
  const [selectedDevice, setSelectedDevice] = useState<string | undefined>(() => _lastSelected);
  // 每 5s tick 一次：重算 isOnline（ONLINE_STALE_MS 過期判斷）
  const [, setTick] = useState(0);

  const { data: irDevicesData } = useIrDevices();
  const { data: edgesData } = useEdges();

  /** TC 編號 → { deviceId, location } */
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
        receivedAt: Date.now(),
      };

      // 先寫模組快取 + sessionStorage，再更新 React state
      _frameCache[sseFrame.device_id] = state;
      saveFrameToStorage(sseFrame.device_id, state);
      setFrames((prev) => ({ ...prev, [sseFrame.device_id]: state }));
      setSelectedDevice((prev) => {
        const next = prev ?? sseFrame.device_id;
        _lastSelected = next;
        try { sessionStorage.setItem(SS_SELECTED, next); } catch { /* 靜默忽略 */ }
        return next;
      });
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

  // 每 5s 重算 isOnline（ONLINE_STALE_MS 判斷）
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 5_000);
    return () => clearInterval(t);
  }, []);

  const now = Date.now();

  const tcButtons = useMemo<TcButtonData[]>(
    () =>
      Array.from({ length: TC_COUNT }, (_, i) => {
        const num = i + 1;
        const info = tcToInfo.get(num);
        const deviceId = info?.deviceId;
        const location = info?.location ?? '';
        // 在線判斷：React state 中有 frame 且 receivedAt 未超過 ONLINE_STALE_MS
        const isOnline =
          !!deviceId &&
          !!frames[deviceId] &&
          now - frames[deviceId]!.receivedAt < ONLINE_STALE_MS;
        const isSelected = !!deviceId && selectedDevice === deviceId;
        return { num, deviceId, location, isOnline, isSelected };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tcToInfo, frames, selectedDevice, now],
  );

  /**
   * 顯示 frame：
   *   1. React state（最新）
   *   2. 模組快取（fallback — 對抗 state 重置，保留最後一張）
   */
  const frame = selectedDevice
    ? (frames[selectedDevice] ?? _frameCache[selectedDevice] ?? null)
    : null;

  return (
    <Spin spinning={false}>
      <div style={{ marginBottom: 16 }}>
        <Title level={3} style={{ margin: 0 }}>
          熱力圖即時監控
        </Title>
      </div>

      {/* 4×4 固定按鈕格（在線=綠, 離線=藍, 選中=金框；含安裝位置名稱） */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${COLS}, minmax(0, 1fr))`,
          gap: 11,
          marginBottom: 16,
          width: '48%',
        }}
      >
        {tcButtons.map(({ num, deviceId, location, isOnline, isSelected }) => {
          const tcCode = `TC${String(num).padStart(2, '0')}`;
          const bg = isOnline ? '#52c41a' : '#1677ff';
          return (
            <Button
              key={num}
              block
              onClick={() => {
                if (deviceId) {
                  _lastSelected = deviceId;
                  try { sessionStorage.setItem(SS_SELECTED, deviceId); } catch { /* 靜默忽略 */ }
                  setSelectedDevice(deviceId);
                }
              }}
              disabled={!deviceId}
              style={{
                backgroundColor: bg,
                borderColor: isSelected ? '#faad14' : bg,
                color: '#fff',
                boxShadow: isSelected ? '0 0 0 2px #faad14' : undefined,
                opacity: deviceId ? 1 : 0.35,
                height: 'auto',
                padding: '8px 11px',
                textAlign: 'center',
                lineHeight: 1.3,
                whiteSpace: 'normal',
                wordBreak: 'break-all',
              }}
            >
              {/* flex column wrapper — 強制 TC 編號與位置名稱各占一行 */}
              <span
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  width: '100%',
                  gap: 2,
                }}
              >
                <span style={{ fontWeight: 700, fontSize: 18 }}>{tcCode}</span>
                {location && (
                  <span
                    style={{
                      fontSize: 14,
                      opacity: 0.92,
                      whiteSpace: 'normal',
                      wordBreak: 'break-all',
                      textAlign: 'center',
                    }}
                  >
                    {location}
                  </span>
                )}
              </span>
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
          <div style={{ padding: '4px 10px', fontSize: 12, color: '#666', textAlign: 'right', borderTop: '1px solid #f0f0f0' }}>
            最後更新：{(() => { try { return new Date(frame.timestamp).toLocaleString('zh-TW'); } catch { return frame.timestamp; } })()}
          </div>
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
