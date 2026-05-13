/**
 * useEcsu — ECSU 列表 + per-ECSU 補強 hooks（M-PM-219 T-AdminUI-010 §二）
 *
 * 對接 backend M-P12-046 既有 8 endpoints：
 *   GET    /v1/admin/ecsu                       → list (parent_id 自參照樹)
 *   POST   /v1/admin/ecsu                       → create
 *   PATCH  /v1/admin/ecsu/{id}                  → update
 *   DELETE /v1/admin/ecsu/{id}                  → delete (409 if has children)
 *   GET    /v1/admin/ecsu/{id}/circuits         → { circuits[], count }
 *   GET    /v1/admin/ecsu/{id}/realtime         → { realtime_kw, active_bindings }
 *   GET    /v1/admin/ecsu/{id}/monthly          → { monthly_kwh, active_bindings }
 *
 * Performance（M-PM-219 §三 自決策略 A）：per-row react-query + cache；
 *   realtime staleTime 5s（接近即時）；monthly staleTime 60s（月內變化慢）
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '../services/api';

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface EcsuRow {
  ecsu_id: number;
  ecsu_code: string;
  ecsu_name: string;
  parent_id: number | null;
  display_seq: number | null;
  enabled: boolean;
  remark_desc?: string | null;
}

export interface EcsuCircuitsResp {
  ecsu_id: number;
  ecsu_code: string;
  ecsu_name: string;
  circuits: Array<{
    assgn_id: number;
    device_id: string;
    circuit_code: string;
    sign: -1 | 1;
    enabled: boolean;
    remark_desc?: string | null;
  }>;
  count: number;
}

export interface EcsuRealtimeResp {
  ecsu_id: number;
  realtime_kw: number;
  active_bindings: number;
  window: '5min';
  parameter_code: 'power_total';
}

export interface EcsuMonthlyResp {
  ecsu_id: number;
  monthly_kwh: number;
  active_bindings: number;
  window: 'month_to_date';
  parameter_code: 'energy_kwh_imp';
}

export interface EcsuFormBody {
  ecsu_code: string;
  ecsu_name: string;
  parent_id?: number | null;
  display_seq?: number | null;
  enabled?: boolean;
  remark_desc?: string | null;
}

// ─────────────────────────────────────────────────────────────
// Query keys
// ─────────────────────────────────────────────────────────────

const ecsuKeys = {
  all: ['ecsu'] as const,
  list: () => [...ecsuKeys.all, 'list'] as const,
  detail: (id: number) => [...ecsuKeys.all, 'detail', id] as const,
  circuits: (id: number) => [...ecsuKeys.all, 'circuits', id] as const,
  realtime: (id: number) => [...ecsuKeys.all, 'realtime', id] as const,
  monthly: (id: number) => [...ecsuKeys.all, 'monthly', id] as const,
};

// ─────────────────────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────────────────────

/** List all ECSU rows */
export function useEcsuList() {
  return useQuery({
    queryKey: ecsuKeys.list(),
    queryFn: async (): Promise<EcsuRow[]> => {
      const { data } = await api.get<EcsuRow[]>('/admin/ecsu');
      return Array.isArray(data) ? data : [];
    },
    staleTime: 30_000,
  });
}

/** Per-ECSU bound circuits count（M-PM-219 §2.1 列表 column）*/
export function useEcsuCircuits(ecsuId: number | null | undefined) {
  return useQuery({
    queryKey: ecsuKeys.circuits(ecsuId ?? -1),
    queryFn: async (): Promise<EcsuCircuitsResp> => {
      const { data } = await api.get<EcsuCircuitsResp>(`/admin/ecsu/${ecsuId}/circuits`);
      return data;
    },
    enabled: ecsuId != null,
    staleTime: 60_000, // 綁定變動慢；1 min cache
  });
}

/** Per-ECSU 即時用電（5min window）*/
export function useEcsuRealtime(ecsuId: number | null | undefined) {
  return useQuery({
    queryKey: ecsuKeys.realtime(ecsuId ?? -1),
    queryFn: async (): Promise<EcsuRealtimeResp> => {
      const { data } = await api.get<EcsuRealtimeResp>(`/admin/ecsu/${ecsuId}/realtime`);
      return data;
    },
    enabled: ecsuId != null,
    staleTime: 5_000, // 接近即時
    refetchInterval: 30_000, // 30s 自動 refresh
  });
}

/** Per-ECSU 本月累積（month-to-date）*/
export function useEcsuMonthly(ecsuId: number | null | undefined) {
  return useQuery({
    queryKey: ecsuKeys.monthly(ecsuId ?? -1),
    queryFn: async (): Promise<EcsuMonthlyResp> => {
      const { data } = await api.get<EcsuMonthlyResp>(`/admin/ecsu/${ecsuId}/monthly`);
      return data;
    },
    enabled: ecsuId != null,
    staleTime: 60_000, // 月內變化慢
  });
}

// ─────────────────────────────────────────────────────────────
// Mutations
// ─────────────────────────────────────────────────────────────

export function useCreateEcsu() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: EcsuFormBody) => {
      const { data } = await api.post('/admin/ecsu', body);
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ecsuKeys.all }),
  });
}

export function useUpdateEcsu() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ ecsu_id, ...body }: EcsuFormBody & { ecsu_id: number }) => {
      const { data } = await api.patch(`/admin/ecsu/${ecsu_id}`, body);
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ecsuKeys.all }),
  });
}

export function useDeleteEcsu() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (ecsu_id: number) => {
      const { data } = await api.delete(`/admin/ecsu/${ecsu_id}`);
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ecsuKeys.all }),
  });
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/**
 * 把 flat ECSU list 轉成 tree（parent_id 自參照）
 * 用於 antd Table expandable layout
 */
export function buildEcsuTree(rows: EcsuRow[]): Array<EcsuRow & { children?: EcsuRow[] }> {
  if (!rows.length) return [];
  const byId = new Map<number, EcsuRow & { children?: EcsuRow[] }>();
  rows.forEach((r) => byId.set(r.ecsu_id, { ...r, children: undefined }));
  const roots: Array<EcsuRow & { children?: EcsuRow[] }> = [];
  byId.forEach((node) => {
    if (node.parent_id == null) {
      roots.push(node);
    } else {
      const parent = byId.get(node.parent_id);
      if (parent) {
        if (!parent.children) parent.children = [];
        parent.children.push(node);
      } else {
        // parent_id 不在 list 中（orphan）→ 視為 root
        roots.push(node);
      }
    }
  });
  // sort by display_seq
  const sortFn = (a: EcsuRow, b: EcsuRow) =>
    (a.display_seq ?? 999) - (b.display_seq ?? 999) || a.ecsu_id - b.ecsu_id;
  roots.sort(sortFn);
  byId.forEach((n) => n.children?.sort(sortFn));
  return roots;
}
