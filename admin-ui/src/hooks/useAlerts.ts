/**
 * Alert hooks — T-S11C-002 Phase γ/δ admin-ui 整合（M-PM-088 §2.1 採納）
 *
 * 對接 P12 alert API 3 endpoints（M-P12-024 / M-PM-085 §3 / commit `ada159f` + `49a681d`）：
 *   GET  /v1/alerts/active                              → AlertActive[]
 *   GET  /v1/alerts/history                             → AlertHistoryEvent[]
 *   PUT  /v1/alerts/{alert_id}/ack                      → AlertActive (idempotent)
 *
 * 設計依據：
 * - ADR-028 §8.3 admin-ui 整合：Reports Thermal Tab 狀態徽章 + 異常履歷 + Edge-down banner
 * - M-P12-023 §8.4 徽章顏色建議：critical 紅 / warning 黃 / info 藍 / suppressed 灰
 * - M-P12-024 §六 ack idempotent：重打 200 不報錯
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '../services/api';

/** alert severity（P12 規格；對齊 ems_alert_rule.severity）*/
export type AlertSeverity = 'critical' | 'warning' | 'info';

/** alert status（ems_alert_active.status）*/
export type AlertStatus = 'active' | 'acknowledged';

/** alert scope（ems_alert_rule.scope；本 admin-ui 只處理 device_kind / edge / system）*/
export type AlertScope = 'device' | 'device_kind' | 'edge' | 'system';

/** alert category（ems_alert_rule.category；hardware / software）*/
export type AlertCategory = 'hardware' | 'software';

/** event_type 6 種（M-P12-024 §6.3；含 ADR-028 cross-cutting）*/
export type AlertEventType =
  | 'triggered'
  | 'acknowledged'
  | 'auto_resolved'
  | 'cleared'
  | 'escalated'
  | 'suppressed_by_edge_down';

/** GET /v1/alerts/active 回傳一筆（M-P12-024 §6.2 JOIN 後欄位）*/
export interface AlertActive {
  alert_id: number;
  rule_id: number;
  rule_name: string;
  category: AlertCategory;
  scope: AlertScope;
  device_id: string | null;
  edge_id: string | null;
  severity: AlertSeverity;
  status: AlertStatus;
  triggered_at: string;
  message: string;
  trigger_value: number | null;
  trigger_metric: string | null;
  last_value: number | null;
  last_seen_at: string | null;
  acked_by: string | null;
  acked_at: string | null;
  ack_note: string | null;
}

/** GET /v1/alerts/history 回傳一筆 */
export interface AlertHistoryEvent {
  ts: string;
  alert_id: number | null;
  rule_id: number;
  rule_name: string;
  event_type: AlertEventType;
  device_id: string | null;
  edge_id: string | null;
  severity: AlertSeverity;
  message: string | null;
  actor: string | null;
  note: string | null;
}

/** GET /v1/alerts/active query params（subset；可擴）*/
export interface AlertActiveFilter {
  device_id?: string;
  edge_id?: string;
  severity?: AlertSeverity;
}

/** GET /v1/alerts/history query params */
export interface AlertHistoryFilter {
  device_id?: string;
  edge_id?: string;
  event_type?: AlertEventType;
  severity?: AlertSeverity;
  since?: string; // ISO 8601
  until?: string; // ISO 8601
  limit?: number; // server max 1000
}

/** PUT body */
export interface AckAlertBody {
  acked_by: string;
  ack_note?: string;
}

const ACTIVE_KEY = ['alerts', 'active'] as const;
const HISTORY_KEY = ['alerts', 'history'] as const;

/** 30 秒 polling；對齊 P12 worker tick 30 s（M-P12-023 §4.1）*/
const ACTIVE_REFETCH_MS = 30_000;

export function useActiveAlerts(filter: AlertActiveFilter = {}) {
  return useQuery({
    queryKey: [...ACTIVE_KEY, filter] as const,
    queryFn: async () => {
      const r = await api.get<AlertActive[]>('/alerts/active', { params: filter });
      return Array.isArray(r.data) ? r.data : [];
    },
    refetchInterval: ACTIVE_REFETCH_MS,
    staleTime: 10_000,
  });
}

export function useAlertHistory(filter: AlertHistoryFilter = {}) {
  return useQuery({
    queryKey: [...HISTORY_KEY, filter] as const,
    queryFn: async () => {
      const r = await api.get<AlertHistoryEvent[]>('/alerts/history', { params: filter });
      return Array.isArray(r.data) ? r.data : [];
    },
    staleTime: 30_000,
  });
}

export function useAckAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ alert_id, body }: { alert_id: number; body: AckAlertBody }) => {
      const r = await api.put<AlertActive>(`/alerts/${alert_id}/ack`, body);
      return r.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ACTIVE_KEY });
      qc.invalidateQueries({ queryKey: HISTORY_KEY });
    },
  });
}

// ─────────────────────────────────────────────────────────────
// helpers — 共用 UI 邏輯（避免在元件層 if-else 散落）
// ─────────────────────────────────────────────────────────────

/** Severity → AntD Tag color；對齊 M-P12-023 §8.4 + ADR-028 §8.3 */
export function severityColor(severity: AlertSeverity): string {
  switch (severity) {
    case 'critical':
      return 'red';
    case 'warning':
      return 'orange';
    case 'info':
      return 'blue';
  }
}

/** Severity 中文標籤 */
export function severityLabel(severity: AlertSeverity): string {
  switch (severity) {
    case 'critical':
      return '危險';
    case 'warning':
      return '警告';
    case 'info':
      return '注意';
  }
}

/** event_type 中文標籤 */
export function eventTypeLabel(t: AlertEventType): string {
  switch (t) {
    case 'triggered':
      return '觸發';
    case 'acknowledged':
      return '已確認';
    case 'auto_resolved':
      return '自動恢復';
    case 'cleared':
      return '已清除';
    case 'escalated':
      return '升級';
    case 'suppressed_by_edge_down':
      return 'Edge 抑制';
  }
}

/** event_type → AntD Tag color */
export function eventTypeColor(t: AlertEventType): string {
  switch (t) {
    case 'triggered':
      return 'red';
    case 'acknowledged':
      return 'blue';
    case 'auto_resolved':
      return 'green';
    case 'cleared':
      return 'default';
    case 'escalated':
      return 'volcano';
    case 'suppressed_by_edge_down':
      return 'default';
  }
}

/** 設備狀態徽章 5 態（含 Edge-down 抑制 cross-cutting；ADR-028 §8.3）*/
export type DeviceHealthState = 'normal' | 'info' | 'warning' | 'critical' | 'edge_suppressed';

export interface DeviceHealthBadge {
  state: DeviceHealthState;
  color: string; // AntD Tag color
  emoji: string; // 螢幕無 icon font 時 fallback
  label: string;
  tooltip: string;
}

/**
 * 計算單一 device 的當下健康狀態
 * 邏輯（順位由高至低）：
 *   1. Edge-down 抑制：若 device.edge_id 對應的 edge 有 scope='edge' active critical → 'edge_suppressed'
 *   2. 否則取 device active alert 的最高 severity
 *   3. 無 active alert → 'normal'
 *
 * @param deviceId      要評估的 device_id
 * @param activeAlerts  全部 active alert（從 useActiveAlerts() 撈一次共用）
 * @param deviceEdgeId  該 device 對應的 edge_id（若有；用於 Edge-down 判斷）
 */
export function computeDeviceHealth(
  deviceId: string,
  activeAlerts: AlertActive[],
  deviceEdgeId?: string | null,
): DeviceHealthBadge {
  // Step 1: Edge-down 抑制判斷
  if (deviceEdgeId) {
    const edgeDown = activeAlerts.some(
      (a) =>
        a.scope === 'edge' &&
        a.severity === 'critical' &&
        a.status === 'active' &&
        a.edge_id === deviceEdgeId,
    );
    if (edgeDown) {
      return {
        state: 'edge_suppressed',
        color: 'default',
        emoji: '⚪',
        label: 'Edge 抑制',
        tooltip: `Edge ${deviceEdgeId} 失聯中；本設備個別告警暫停判斷`,
      };
    }
  }

  // Step 2: 該 device 自身的 active alerts
  const own = activeAlerts.filter(
    (a) => a.device_id === deviceId && a.status === 'active',
  );
  if (own.length === 0) {
    return {
      state: 'normal',
      color: 'green',
      emoji: '🟢',
      label: '正常',
      tooltip: '無 active 告警',
    };
  }

  // 取最高 severity
  const hasCritical = own.some((a) => a.severity === 'critical');
  const hasWarning = own.some((a) => a.severity === 'warning');
  if (hasCritical) {
    return {
      state: 'critical',
      color: 'red',
      emoji: '🔴',
      label: '危險',
      tooltip: `${own.length} 件 active；含 critical`,
    };
  }
  if (hasWarning) {
    return {
      state: 'warning',
      color: 'orange',
      emoji: '🟠',
      label: '警告',
      tooltip: `${own.length} 件 active；warning`,
    };
  }
  return {
    state: 'info',
    color: 'gold',
    emoji: '🟡',
    label: '注意',
    tooltip: `${own.length} 件 active；info`,
  };
}

/** 是否有 scope='edge' 且 critical active（Reports Thermal Tab Edge-down banner 顯示判斷）*/
export function findEdgeDownAlerts(activeAlerts: AlertActive[]): AlertActive[] {
  return activeAlerts.filter(
    (a) => a.scope === 'edge' && a.severity === 'critical' && a.status === 'active',
  );
}
