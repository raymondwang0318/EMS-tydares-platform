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
  /**
   * 所屬 Edge ID。
   *
   * - M-PM-110 軌 A① schema migration 後 backend ir-devices SELECT 會回傳此欄位
   * - 過渡期（schema migration 未完前）後端 SELECT 不含此欄位 → undefined → UI 走 fallback
   * - M-PM-111 §2.3 / §3.3 fallback：當前 7 顆 IR 全在 Edge01（TYDARES-E66；M-PM-104 §3.2）
   */
  edge_id?: string | null;
}

/**
 * IR 設備所屬 Edge fallback 邏輯（M-PM-111 §2.3）。
 *
 * 軌 A① schema migration 完成前 IrDevice.edge_id 為 undefined；統一走 'TYDARES-E66'。
 * Phase 2（schema migration 完成）後端會回傳真實 edge_id；本 helper 自動透傳。
 */
export const FALLBACK_EDGE_ID = 'TYDARES-E66';
export function getIrEdgeId(device: IrDevice): string {
  const v = (device.edge_id ?? '').trim();
  return v || FALLBACK_EDGE_ID;
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
    mutationFn: async ({
      device_id,
      display_name,
      edge_id,
    }: {
      device_id: string;
      display_name: string;
      /**
       * M-PM-111 軌 A③.1 — 過渡期送 edge_id；軌 A① schema migration 完成後 backend 會接受寫入。
       * 當前 backend `PUT /admin/ir-devices/{id}/label` 只認 display_name；edge_id 多送會被
       * Pydantic / Body parse 忽略（FastAPI default extra='ignore'）；不影響既有交卷。
       */
      edge_id?: string | null;
    }) => {
      const body: Record<string, unknown> = { display_name };
      if (edge_id != null) body.edge_id = edge_id;
      const r = await api.put<IrDevice>(
        `/admin/ir-devices/${encodeURIComponent(device_id)}/label`,
        body,
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
