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
  // M-PM-255 / M-P12-061: fnd_ecsu region nullable column（業主自填區域；schema +1）
  region?: string | null;
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
  // M-PM-255 / M-P12-061: region 對接 backend _ECSU_ALLOWED_FIELDS
  region?: string | null;
}

/**
 * Device-kind circuit option（M-PM-228 backend hardcode constants）
 * 對應 GET /v1/admin/device-models/by-kind/{device_kind}/circuits
 *
 * - aem_drb: 34 circuits（2 main: ma/mb + 24 branch: ba1-12/bb1-12 + 8 three_phase）
 *   三相虛擬迴路（M-PM-237 §C + M-P12-052 commit a889d77）：
 *   ba1-3 / ba4-6 / ba7-9 / ba10-12 / bb1-3 / bb4-6 / bb7-9 / bb10-12
 * - cpm12d:  1 circuit  (main: ma)
 * - cpm23:   1 circuit  (main: ma)
 */
export interface DeviceCircuitOption {
  code: string;
  name: string;
  category: 'main' | 'branch' | 'three_phase';
}

export interface DeviceCircuitsResp {
  device_kind: string;
  circuits: DeviceCircuitOption[];
  count: number;
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

// M-PM-228/229 device_kind → circuits lookup（schema-driven dropdown）
const deviceCircuitsKeys = {
  all: ['device-circuits'] as const,
  byKind: (kind: string) => [...deviceCircuitsKeys.all, 'by-kind', kind] as const,
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

/**
 * Per device_kind 的 circuit list（M-PM-228/229 schema-driven dropdown）
 * Backend：GET /v1/admin/device-models/by-kind/{device_kind}/circuits
 *
 * 設計：
 * - device_kind 為 null → query disabled（用戶尚未選 device）
 * - staleTime: Infinity → backend hardcode constants 永不變動；cache 永久有效
 * - 404 → backend 回 detail 含支援清單（M-PM-228 §3.2 已內建）；frontend catch 後傳空 array
 */
export function useDeviceCircuits(deviceKind: string | null | undefined) {
  return useQuery({
    queryKey: deviceCircuitsKeys.byKind(deviceKind ?? '__none__'),
    queryFn: async (): Promise<DeviceCircuitsResp> => {
      const { data } = await api.get<DeviceCircuitsResp>(
        `/admin/device-models/by-kind/${deviceKind}/circuits`,
      );
      return data;
    },
    enabled: !!deviceKind,
    staleTime: Infinity, // backend hardcode 不變；永久 cache
    retry: 1,
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
// Circuit binding mutations (M-PM-220 §三 多對多綁定)
// 對應 backend M-P12-046:
//   POST   /admin/ecsu/{id}/circuits     → 新增綁定
//   PATCH  /admin/ecsu/circuits/{assgn_id} → 改 sign / enabled / 備註
//   DELETE /admin/ecsu/circuits/{assgn_id} → 移除綁定
// ─────────────────────────────────────────────────────────────

export interface CircuitBindingBody {
  device_id: string;
  circuit_code: string;
  sign: -1 | 1;
  enabled?: boolean;
  remark_desc?: string | null;
}

export function useCreateEcsuCircuit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      ecsu_id,
      ...body
    }: CircuitBindingBody & { ecsu_id: number }) => {
      const { data } = await api.post(`/admin/ecsu/${ecsu_id}/circuits`, body);
      return data;
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ecsuKeys.circuits(vars.ecsu_id) });
      qc.invalidateQueries({ queryKey: ecsuKeys.realtime(vars.ecsu_id) });
      qc.invalidateQueries({ queryKey: ecsuKeys.monthly(vars.ecsu_id) });
    },
  });
}

export interface CircuitUpdateBody {
  sign?: -1 | 1;
  enabled?: boolean;
  remark_desc?: string | null;
}

export function useUpdateEcsuCircuit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      assgn_id,
      ecsu_id: _ecsu_id, // for cache invalidate
      ...body
    }: CircuitUpdateBody & { assgn_id: number; ecsu_id: number }) => {
      const { data } = await api.patch(`/admin/ecsu/circuits/${assgn_id}`, body);
      return data;
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ecsuKeys.circuits(vars.ecsu_id) });
      qc.invalidateQueries({ queryKey: ecsuKeys.realtime(vars.ecsu_id) });
      qc.invalidateQueries({ queryKey: ecsuKeys.monthly(vars.ecsu_id) });
    },
  });
}

export function useDeleteEcsuCircuit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      assgn_id,
      ecsu_id: _ecsu_id,
    }: {
      assgn_id: number;
      ecsu_id: number;
    }) => {
      const { data } = await api.delete(`/admin/ecsu/circuits/${assgn_id}`);
      return data;
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ecsuKeys.circuits(vars.ecsu_id) });
      qc.invalidateQueries({ queryKey: ecsuKeys.realtime(vars.ecsu_id) });
      qc.invalidateQueries({ queryKey: ecsuKeys.monthly(vars.ecsu_id) });
    },
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
  // M-PM-248: ecsu_code natural sort（老王 5/20 chat『隱藏 ID、排序改代碼、規則 KW-**』+ 5/21 拍板）
  // 翻新 M-PM-231 (commit 0c83ec8 ecsu_id ASC)；改用 ecsu_code 'KW-' 後數字 parseInt 比大小
  // → KW-1 < KW-2 < … < KW-9 < KW-10 < … < KW-21 (natural sort；非字典序 KW-10 < KW-2)
  // 4 拍板對齊（M-PM-248 §三）：
  //   1. 排序：KW- 後數字 natural sort
  //   2. 格式：KW-\d+（不限位數；不強制補零）
  //   3. ID 隱藏範圍：只列表 column；ecsu_id 路由保留
  //   4. 樹狀子節點同步 natural sort（父子一致）
  // Fallback：不符 KW-\d+ 的舊資料排末尾（字串序 tie-break）
  const KW_REGEX = /^KW-(\d+)$/;
  const sortFn = (a: EcsuRow, b: EcsuRow) => {
    const aMatch = a.ecsu_code.match(KW_REGEX);
    const bMatch = b.ecsu_code.match(KW_REGEX);
    if (aMatch && bMatch) {
      return parseInt(aMatch[1], 10) - parseInt(bMatch[1], 10);
    }
    if (aMatch) return -1; // KW-\d+ 排前
    if (bMatch) return 1;
    return a.ecsu_code.localeCompare(b.ecsu_code); // 兩者皆非 KW-\d+ → 字串序
  };
  roots.sort(sortFn);
  byId.forEach((n) => n.children?.sort(sortFn));
  return roots;
}
