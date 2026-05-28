/**
 * 遠端 I/O hooks（M-PM-280 Phase B 真資料整合）
 *
 * Phase A（M-PM-240）→ Phase B（M-PM-280）切換：
 *   VITE_USE_MOCK_REMOTE_IO=false（或未設定）→ 使用真實 backend API
 *   VITE_USE_MOCK_REMOTE_IO=true → 退回 mock data（debug / 展示用）
 *
 * Backend endpoints 對齊 M-P12-058 commit c49725e（10 endpoints）：
 *   GET  /v1/admin/io/devices/{device_id}/status        → DI/DO 16ch state（目前 pending_ingest stub）
 *   POST /v1/admin/io/devices/{device_id}/channels/{ch}/control → DO 控制（✅ 可用）
 *   GET  /v1/admin/io/alarms                           → active alarm 列表（✅ 可用）
 *   POST /v1/admin/io/alarms/{alarm_id}/ack            → alarm ack（✅ 可用）
 *
 * Phase B 設計考量：
 * - DI 狀態目前 data_source=pending_ingest → useFanStatus 回 null → FanCard 顯示「DI 待 ingest」
 * - DO 控制命令入 queue 完整可用 → FanCard 仍顯示 DO 啟動/停止按鈕（Guard stub-pass）
 * - 對齊 v1.4 §51 既有架構優先（保留 mock 路徑，僅切 default + 修 real 路徑）
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FanStatus, FanType } from '../constants/remoteIO';
import { SITE_CONFIGS, getFanChannelMapping } from '../constants/remoteIO';
import api from '../services/api';

// Phase B：預設 false（real data）；保留 env toggle 供 mock 展示用
export const USE_MOCK_DATA: boolean =
  (import.meta.env.VITE_USE_MOCK_REMOTE_IO ?? 'false').toString().toLowerCase() !== 'false';

// ─────────────────────────────────────────────────────────────
// Backend API 回傳型別
// ─────────────────────────────────────────────────────────────

interface ChannelState {
  channel: number;
  state: 0 | 1;
  metric_code?: string;
}

interface DeviceStatusResponse {
  device_id: string;
  channels: ChannelState[] | null;
  data_source: 'trx_io_reading' | 'pending_ingest' | string;
  ts?: string | null;
}

interface ApiAlarm {
  alarm_id: string;
  device_id: string;
  channel: number;
  alarm_type: string;
  severity: string;
  triggered_at: string;
  trigger_metric?: string;
  trigger_value?: number;
  message?: string;
  acked_at?: string | null;
  acked_by?: string | null;
}

// ─────────────────────────────────────────────────────────────
// Types（公開）
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

export interface AckAlarmBody {
  alarm_id: string;
  reason: 'reset_relay' | 'checked' | 'other';
  note?: string;
}

// ─────────────────────────────────────────────────────────────
// Helper：device_id → alarm 展示資訊
// ─────────────────────────────────────────────────────────────

function deviceIdToAlarmInfo(
  device_id: string,
  channel: number,
): { edge_id: string; site_code: string; fan_type: FanType; fan_index: number; fan_name: string } | null {
  // 格式：tcs300b03_di-TYDARES-E17-slave1（ScanWizard confirm 格式）
  const m = device_id.match(/^tcs300b03_di-(.+?)-slave(\d+)$/i);
  if (!m) return null;
  const edge_id = m[1]; // TYDARES-E17
  const slave_di = parseInt(m[2], 10); // 1, 2, 3
  const site = SITE_CONFIGS.find((s) => s.edge_id === edge_id);
  const site_code = site?.code ?? '??';

  // 反推 fan_type + fan_index（對齊 getFanChannelMapping 邏輯）
  // slave 1: ch1-4→fugu1, ch5-8→fugu2, ch9-12→fugu3, ch13-16→fugu4
  // slave 2: ch1-4→fugu5, ch5-8→fugu6, ch9-12→xun1, ch13-16→xun2
  // slave 3: ch1-4→xun3
  let fan_type: FanType = 'fugu';
  let fan_index = 1;
  if (slave_di === 1) {
    fan_type = 'fugu';
    fan_index = Math.ceil(channel / 4);
  } else if (slave_di === 2) {
    if (channel <= 8) {
      fan_type = 'fugu';
      fan_index = 4 + Math.ceil(channel / 4);
    } else {
      fan_type = 'xun';
      fan_index = Math.ceil((channel - 8) / 4);
    }
  } else {
    fan_type = 'xun';
    fan_index = 3;
  }
  const fan_name = fan_type === 'fugu' ? `負壓風扇 ${fan_index}` : `內循環風扇 ${fan_index}`;
  return { edge_id, site_code, fan_type, fan_index, fan_name };
}

// ─────────────────────────────────────────────────────────────
// Mock generator（Phase A 退路；deterministic by site+fan）
// ─────────────────────────────────────────────────────────────

function mockFanStatus(edge_id: string, fan_type: FanType, fan_index: number): FanStatus {
  const seed =
    (edge_id.charCodeAt(edge_id.length - 1) ?? 0) * 100 +
    (fan_type === 'fugu' ? 0 : 50) +
    fan_index;
  const r = seed % 10;
  if (edge_id === 'TYDARES-E17' && fan_type === 'fugu' && fan_index === 2) {
    return { manual: false, auto: true, running: true, overload: true, do_state: true };
  }
  if (r < 5) return { manual: false, auto: true, running: r < 3, overload: false, do_state: r < 3 };
  if (r === 5) return { manual: true, auto: false, running: true, overload: false, do_state: false };
  return { manual: false, auto: false, running: false, overload: false, do_state: false };
}

const MOCK_ACTIVE_ALARMS: ActiveAlarm[] = [
  {
    alarm_id: 'mock-alarm-001',
    site_code: 'A3', // M-P12-079 對齊實體區域編碼（舊 'Aa'）
    edge_id: 'TYDARES-E17',
    fan_type: 'fugu',
    fan_index: 2,
    fan_name: '負壓風扇 2',
    triggered_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    acked: false,
  },
];

// ─────────────────────────────────────────────────────────────
// useFanStatus — 單一風扇即時 DI 狀態
//
// 回傳：
//   FanStatus  → 真實資料（trx_io_reading 補齊後）
//   null       → 資料待 ingest（data_source=pending_ingest）
//   undefined  → 載入中 / 錯誤（useQuery 初始狀態）
// ─────────────────────────────────────────────────────────────

export function useFanStatus(edge_id: string, fan_type: FanType, fan_index: number) {
  return useQuery({
    queryKey: ['remote-io', 'fan-status', edge_id, fan_type, fan_index],
    queryFn: async (): Promise<FanStatus | null> => {
      if (USE_MOCK_DATA) {
        return mockFanStatus(edge_id, fan_type, fan_index);
      }
      const mapping = getFanChannelMapping(fan_type, fan_index);
      // device_id 對齊 ScanWizard confirm 格式：tcs300b03_di-{edge_id}-slave{N}
      const deviceId = `tcs300b03_di-${edge_id}-slave${mapping.slave_di}`;
      try {
        const r = await api.get<DeviceStatusResponse>(
          `/admin/io/devices/${encodeURIComponent(deviceId)}/status`,
        );
        const { channels, data_source } = r.data;
        if (data_source === 'pending_ingest' || !channels) {
          return null; // DI ingest pipeline 尚未補齊 → FanCard 顯示「DI 待 ingest」
        }
        // 對映 di_channel_base → FanStatus（手動/自動/運轉/過載）
        const base = mapping.di_channel_base; // 1-based
        const getState = (ch: number) => channels.find((c) => c.channel === ch)?.state === 1;
        return {
          manual: getState(base),
          auto: getState(base + 1),
          running: getState(base + 2),
          overload: getState(base + 3),
          do_state: false, // DO state 需獨立查 DO device；Phase B 暫不實作（ingest 補齊後統一）
        };
      } catch (err: any) {
        // 404：device 尚未在 DB 建立 → 視同 pending_ingest（DO 控制仍可用）
        if (err?.response?.status === 404) return null;
        throw err; // 其他錯誤繼續往上拋
      }
    },
    refetchInterval: 5000,
    staleTime: 1000,
  });
}

// ─────────────────────────────────────────────────────────────
// useDOControl — DO 啟動 / 停止 mutation
//
// Real API：POST /v1/admin/io/devices/{device_id}/channels/{ch}/control
//   device_id = tcs300b04-{edge_id}-DO1
//   channel   = mapping.do_channel（1-9）
//   relay_id  = E{edge_num}-DO1-ch{do_channel}
// ─────────────────────────────────────────────────────────────

export function useDOControl() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      edge_id: string;
      fan_type: FanType;
      fan_index: number;
      new_state: boolean;
    }): Promise<{ status: string; command_id?: string }> => {
      if (USE_MOCK_DATA) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return { status: 'mock_ok' };
      }
      const mapping = getFanChannelMapping(vars.fan_type, vars.fan_index);
      // device_id 對齊 ScanWizard confirm 格式：tcs300b04_do-{edge_id}-slave4
      // TCS300B04 (DO) 各 edge 固定 Modbus slave 4；ScanWizard 以此建立 device record
      // backend Guard 3 檢查 device_kind='tcs300b04_do'；DB lookup 需與 ScanWizard 寫入格式一致
      const doDeviceId = `tcs300b04_do-${vars.edge_id}-slave4`;
      const edgeNum = vars.edge_id.match(/E(\d+)$/)?.[1] ?? '??';
      const relayId = `E${edgeNum}-DO1-ch${mapping.do_channel}`;
      const r = await api.post<{ command_id?: string; status?: string; command_type?: string }>(
        `/admin/io/devices/${encodeURIComponent(doDeviceId)}/channels/${mapping.do_channel}/control`,
        {
          state: vars.new_state,           // ControlBody.state: boolean（True=ON / False=OFF）
          actor: 'admin',                  // ControlBody.actor（非 operator）
          reason: `遠端 I/O 操作（admin-ui）relay_id=${relayId}`,
        },
      );
      return { status: r.data.status ?? 'queued', command_id: r.data.command_id };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['remote-io', 'fan-status'] });
    },
  });
}

// ─────────────────────────────────────────────────────────────
// useActiveAlarms — fleet active 過載 alarms
//
// Real API：GET /v1/admin/io/alarms → { alarms: ApiAlarm[], total: number }
// 只取 acked_at === null（未確認）
// ─────────────────────────────────────────────────────────────

export function useActiveAlarms() {
  return useQuery({
    queryKey: ['remote-io', 'active-alarms'],
    queryFn: async (): Promise<ActiveAlarm[]> => {
      if (USE_MOCK_DATA) return MOCK_ACTIVE_ALARMS;
      const r = await api.get<{ alarms: ApiAlarm[]; total: number }>('/admin/io/alarms');
      const rawAlarms: ApiAlarm[] = r.data?.alarms ?? [];
      return rawAlarms
        .filter((a) => a.acked_at === null || a.acked_at === undefined)
        .map((a): ActiveAlarm => {
          const info = deviceIdToAlarmInfo(a.device_id, a.channel);
          return {
            alarm_id: a.alarm_id,
            site_code: info?.site_code ?? '??',
            edge_id: info?.edge_id ?? a.device_id,
            fan_type: info?.fan_type ?? 'fugu',
            fan_index: info?.fan_index ?? 0,
            fan_name: info?.fan_name ?? a.message ?? a.device_id,
            triggered_at: a.triggered_at,
            acked: false,
          };
        });
    },
    refetchInterval: 5000,
  });
}

// ─────────────────────────────────────────────────────────────
// useAckAlarm — 過載 manual ack mutation
//
// Real API：POST /v1/admin/io/alarms/{alarm_id}/ack
//   body：{ acked_by: 'admin', ack_note: reason[; note] }
// ─────────────────────────────────────────────────────────────

export function useAckAlarm() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: AckAlarmBody): Promise<{ status: string }> => {
      if (USE_MOCK_DATA) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        const idx = MOCK_ACTIVE_ALARMS.findIndex((a) => a.alarm_id === body.alarm_id);
        if (idx >= 0) MOCK_ACTIVE_ALARMS.splice(idx, 1);
        return { status: 'mock_acked' };
      }
      const ackNote = body.reason + (body.note ? `; ${body.note}` : '');
      const r = await api.post<{ alarm_id: string; acked_at: string; acked_by: string }>(
        `/admin/io/alarms/${encodeURIComponent(body.alarm_id)}/ack`,
        { acked_by: 'admin', ack_note: ackNote },
      );
      return { status: r.data.acked_at ? 'acked' : 'ok' };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['remote-io', 'active-alarms'] });
      qc.invalidateQueries({ queryKey: ['remote-io', 'fan-status'] });
    },
  });
}
