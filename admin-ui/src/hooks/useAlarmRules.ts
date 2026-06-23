/**
 * Alarm rule hooks（M-PM-313 階段2 P1）— thermal 三級閾值 config。
 *
 * 對接 P12A v1_admin_alarms.py：
 *   GET   /v1/admin/alarm-rules?rule_type=thermal_temp_exceed → AlarmRule[]
 *   PATCH /v1/admin/alarm-rules/{rule_id}                      → 更新 threshold/enabled
 *
 * ⚠️ ems_alarm_rule 是「閾值 config」表，與舊 alert 框架（/v1/alerts）範式不同。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '../services/api';

export interface AlarmRule {
  rule_id: number;
  rule_type: string;
  device_scope: string | null;
  device_id: string | null;
  threshold_value: number;
  threshold_unit: string | null;
  severity: 'info' | 'warn' | 'critical' | string;
  source: string;
  enabled: boolean;
  description: string | null;
  created_at: string | null;
}

export const THERMAL_RULE_TYPE = 'thermal_temp_exceed';
const ALARM_RULES_KEY = (ruleType: string) => ['alarm-rules', ruleType] as const;

export function useThermalAlarmRules() {
  return useQuery({
    queryKey: ALARM_RULES_KEY(THERMAL_RULE_TYPE),
    queryFn: async () => {
      const r = await api.get<AlarmRule[]>('/admin/alarm-rules', {
        params: { rule_type: THERMAL_RULE_TYPE },
      });
      return Array.isArray(r.data) ? r.data : [];
    },
    staleTime: 30_000,
  });
}

export interface AlarmRulePatch {
  threshold_value?: number;
  severity?: string;
  enabled?: boolean;
  description?: string;
}

export function useUpdateAlarmRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ rule_id, patch }: { rule_id: number; patch: AlarmRulePatch }) => {
      const r = await api.patch<AlarmRule>(`/admin/alarm-rules/${rule_id}`, patch);
      return r.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alarm-rules'] });
    },
  });
}
