/**
 * IR (811C) device metadata hooks
 *
 * 對接 [[T-S11C-001]] AC 4 P12 endpoints（M-PM-074 + M-PM-084 已 ✅ 簽核）：
 *   GET  /v1/admin/ir-devices                  → IrDevice[]
 *   PUT  /v1/admin/ir-devices/{device_id}/label → upsert display_name
 *
 * 設計依據（M-PM-084 §1.5 DLC 候選 / ADR-028 DR-028-02）：
 * - 811C 不註冊 ems_device 主表
 * - device_id 從 trx_reading 派生（per-device cutover 後天然 register）
 * - display_name 由人工命名；last_seen 由 trx_reading 派生（後端 LEFT JOIN）
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '../services/api';

export interface IrDevice {
  device_id: string; // e.g. "811c_00-0d-e0-92-11-9e"
  display_name: string | null;
  last_seen: string | null; // ISO 8601 UTC
}

const IR_DEVICES_KEY = ['ir-devices'] as const;

export function useIrDevices() {
  return useQuery({
    queryKey: IR_DEVICES_KEY,
    queryFn: async () => {
      const r = await api.get<IrDevice[]>('/admin/ir-devices');
      return Array.isArray(r.data) ? r.data : [];
    },
    staleTime: 30_000, // 30s；IR 設備清單不常變
  });
}

export function useUpsertIrLabel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ device_id, display_name }: { device_id: string; display_name: string }) => {
      const r = await api.put<IrDevice>(
        `/admin/ir-devices/${encodeURIComponent(device_id)}/label`,
        { display_name },
      );
      return r.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: IR_DEVICES_KEY });
    },
  });
}

/**
 * IR 設備顯示名稱優先序（M-PM-074 §4.2 / T-S11C-001 AC 6）：
 *   1. display_name 不為 null/空字串 → 直接顯示
 *   2. 否則 → 「未命名 IR-{idx + 1}」（橘色提示由 caller 處理）
 *
 * @param device IrDevice
 * @param index  該 device 在清單中的順序（0-based）
 */
export function irDisplayLabel(device: IrDevice, index: number): string {
  const n = (device.display_name ?? '').trim();
  if (n) return n;
  return `未命名 IR-${index + 1}`;
}

/**
 * 是否為「未命名」狀態（用於 UI 上色 / 警告判斷）。
 */
export function isIrUnnamed(device: IrDevice): boolean {
  return !((device.display_name ?? '').trim());
}
