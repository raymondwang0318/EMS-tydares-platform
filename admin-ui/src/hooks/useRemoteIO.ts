/**
 * 遠端 I/O hooks (M-PM-240 Phase A mock 階段)
 *
 * mock data fallback：USE_MOCK_DATA = true（hardcode）
 * 後續 M-PM-242 backend ready 後：
 *   - 環境變數 VITE_USE_MOCK_REMOTE_IO=false
 *   - useFanStatus + useActiveAlarms 切 real API（fetch /v1/admin/io/...）
 *   - 不大量改 UI（hook 內部 swap）
 *
 * 對齊 v1.4 §51 既有架構優先（react-query pattern；不擴 schema）
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FanStatus, FanType } from '../constants/remoteIO';
import { getFanChannelMapping } from '../constants/remoteIO';

// Phase A mock 階段 toggle；env override 預備（後續 backend ready 切 false）
const USE_MOCK_DATA: boolean =
  (import.meta.env.VITE_USE_MOCK_REMOTE_IO ?? 'true').toString().toLowerCase() !== 'false';

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface ActiveAlarm {
  alarm_id: string;
  site_code: string;
  edge_id: string;
  fan_type: FanType;
  fan_index: number;
  fan_name: string;
  triggered_at: string; // ISO timestamp
  acked: boolean;
}

// ─────────────────────────────────────────────────────────────
// Mock generator（純 client；穩定 deterministic 依 site+fan）
// ─────────────────────────────────────────────────────────────

/**
 * 依 site + fan 產 deterministic mock status
 * - 過載：edge_id E17 + 負壓 2（單一過載 demo）
 * - 自動運轉：~50% 風扇
 * - 手動：~10% 風扇
 * - 停止：~40% 風扇
 */
function mockFanStatus(
  edge_id: string,
  fan_type: FanType,
  fan_index: number,
): FanStatus {
  // Deterministic seed
  const seed =
    (edge_id.charCodeAt(edge_id.length - 1) ?? 0) * 100 +
    (fan_type === 'fugu' ? 0 : 50) +
    fan_index;
  const r = seed % 10;

  // Aa (E17) 負壓 2：過載 demo
  if (edge_id === 'TYDARES-E17' && fan_type === 'fugu' && fan_index === 2) {
    return { manual: false, auto: true, running: true, overload: true, do_state: true };
  }

  // 自動運轉中（r < 5）— ~50%
  if (r < 5) return { manual: false, auto: true, running: r < 3, overload: false, do_state: r < 3 };
  // 手動運轉（r === 5）— ~10%
  if (r === 5) return { manual: true, auto: false, running: true, overload: false, do_state: false };
  // 停止（其他）
  return { manual: false, auto: false, running: false, overload: false, do_state: false };
}

/**
 * useFanStatus — 取單一風扇即時狀態（mock 或 real API）
 *
 * @param edge_id - TYDARES-E17 等
 * @param fan_type - 'fugu' / 'xun'
 * @param fan_index - 1-6（負壓）/ 1-3（循環）
 *
 * mock 階段：deterministic mock；refetchInterval 5s 模擬即時
 * real 階段：fetch /v1/admin/io/{edge_id}/channels/status?slave={slave}
 */
export function useFanStatus(edge_id: string, fan_type: FanType, fan_index: number) {
  return useQuery({
    queryKey: ['remote-io', 'fan-status', edge_id, fan_type, fan_index],
    queryFn: async (): Promise<FanStatus> => {
      if (USE_MOCK_DATA) {
        return mockFanStatus(edge_id, fan_type, fan_index);
      }
      // Real API path（M-PM-242 backend ready 後啟用）
      const mapping = getFanChannelMapping(fan_type, fan_index);
      const res = await fetch(
        `/v1/admin/io/${edge_id}/channels/status?slave=${mapping.slave_di}`,
      );
      if (!res.ok) throw new Error(`fan status fetch failed: ${res.status}`);
      const data: { di: boolean[]; do: boolean[] } = await res.json();
      const base = mapping.di_channel_base - 1; // 0-indexed
      return {
        manual: data.di[base + 0] ?? false,
        auto: data.di[base + 1] ?? false,
        running: data.di[base + 2] ?? false,
        overload: data.di[base + 3] ?? false,
        do_state: data.do[mapping.do_channel - 1] ?? false,
      };
    },
    refetchInterval: 5000, // 5s 模擬即時刷新
    staleTime: 1000,
  });
}

/**
 * useDOControl — DO 起動 / 停止 mutation（mock 或 real API）
 */
export function useDOControl() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      edge_id: string;
      fan_type: FanType;
      fan_index: number;
      new_state: boolean;
    }): Promise<{ status: string }> => {
      if (USE_MOCK_DATA) {
        await new Promise((r) => setTimeout(r, 300)); // 模擬延遲
        // mock 不真改 status；refetch 拿同 deterministic mock
        return { status: 'mock_ok' };
      }
      const mapping = getFanChannelMapping(vars.fan_type, vars.fan_index);
      const res = await fetch(
        `/v1/admin/io/${vars.edge_id}/channels/do?slave=${mapping.do_slave}&channel=${mapping.do_channel}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ state: vars.new_state }),
        },
      );
      if (!res.ok) throw new Error(`DO control failed: ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['remote-io', 'fan-status'] });
    },
  });
}

// ─────────────────────────────────────────────────────────────
// Active alarms
// ─────────────────────────────────────────────────────────────

const MOCK_ACTIVE_ALARMS: ActiveAlarm[] = [
  {
    alarm_id: 'mock-alarm-001',
    site_code: 'Aa',
    edge_id: 'TYDARES-E17',
    fan_type: 'fugu',
    fan_index: 2,
    fan_name: '負壓風扇 2',
    triggered_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(), // 30 min ago
    acked: false,
  },
];

/**
 * useActiveAlarms — fleet 全 active 過載 alarms
 *
 * mock：1 alarm（Aa E17 負壓 2）
 * real：fetch /v1/admin/io/alarms/active
 */
export function useActiveAlarms() {
  return useQuery({
    queryKey: ['remote-io', 'active-alarms'],
    queryFn: async (): Promise<ActiveAlarm[]> => {
      if (USE_MOCK_DATA) return MOCK_ACTIVE_ALARMS;
      const res = await fetch('/v1/admin/io/alarms/active');
      if (!res.ok) throw new Error(`alarms fetch failed: ${res.status}`);
      return res.json();
    },
    refetchInterval: 5000,
  });
}

/**
 * useAckAlarm — 過載 manual ack mutation
 */
export interface AckAlarmBody {
  alarm_id: string;
  reason: 'reset_relay' | 'checked' | 'other';
  note?: string;
}

export function useAckAlarm() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: AckAlarmBody): Promise<{ status: string }> => {
      if (USE_MOCK_DATA) {
        await new Promise((r) => setTimeout(r, 300));
        // mock: 從 MOCK_ACTIVE_ALARMS 移除（in-memory）
        const idx = MOCK_ACTIVE_ALARMS.findIndex((a) => a.alarm_id === body.alarm_id);
        if (idx >= 0) MOCK_ACTIVE_ALARMS.splice(idx, 1);
        return { status: 'mock_acked' };
      }
      const res = await fetch(`/v1/admin/io/alarms/${body.alarm_id}/ack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: body.reason, note: body.note }),
      });
      if (!res.ok) throw new Error(`ack alarm failed: ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['remote-io', 'active-alarms'] });
      qc.invalidateQueries({ queryKey: ['remote-io', 'fan-status'] });
    },
  });
}

export { USE_MOCK_DATA };
