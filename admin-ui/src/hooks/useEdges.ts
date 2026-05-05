import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../services/api';
import { queryKeys } from '../lib/queryClient';

export interface Edge {
  edge_id: string;
  edge_name: string | null;
  site_code: string | null;
  hostname: string | null;
  fingerprint: string | null;
  previous_fingerprints: unknown[];
  status: 'pending' | 'approved' | 'maintenance' | 'pending_replace' | 'revoked';
  last_seen_ip: string | null;
  last_seen_at: string | null;
  config_version: number;
  registered_at: string | null;
  approved_at: string | null;
  approved_by: string | null;
  maintenance_at: string | null;
  replaced_at: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
  remark_desc: string | null;
}

export function useEdges() {
  return useQuery({
    queryKey: queryKeys.edges.list(),
    queryFn: async ({ signal }): Promise<Edge[]> => {
      // M-PM-123 通用防禦：明確 abort signal + 10s per-request timeout（蓋過 axios 15s default；
      // 配合 react-query queryClient retry=2，最壞 ~30s 內 settle 不會永久 hang）
      const t0 = Date.now();
      try {
        const { data } = await api.get<Edge[]>('/admin/edges', {
          signal,
          timeout: 10000,
        });
        return data;
      } catch (err) {
        // M-PM-123 §3.5 console 留 trace 方便 F12 採證根因
        console.error('[useEdges] /admin/edges fetch failed', {
          elapsed_ms: Date.now() - t0,
          err,
        });
        throw err;
      }
    },
    refetchInterval: 30_000,
    // M-PM-123 顯式 retry/staleTime（覆蓋 queryClient default `failureCount < 2`；本 query 用 retry=1 加快錯誤可見性）
    retry: 1,
    retryDelay: 500,
    staleTime: 15_000,
  });
}

function invalidateEdges(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: queryKeys.edges.all });
  qc.invalidateQueries({ queryKey: queryKeys.dashboard.all });
}

export function useApproveEdge() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (edgeId: string) => {
      const { data } = await api.post(`/admin/edges/${edgeId}/approve`);
      return data;
    },
    onSuccess: () => invalidateEdges(qc),
  });
}

export function useRevokeEdge() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ edgeId, reason }: { edgeId: string; reason?: string }) => {
      const { data } = await api.post(`/admin/edges/${edgeId}/revoke`, null, {
        params: { reason: reason ?? '' },
      });
      return data;
    },
    onSuccess: () => invalidateEdges(qc),
  });
}

export function useMaintenanceEdge() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (edgeId: string) => {
      const { data } = await api.post(`/admin/edges/${edgeId}/maintenance`);
      return data;
    },
    onSuccess: () => invalidateEdges(qc),
  });
}

export function useResumeEdge() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (edgeId: string) => {
      const { data } = await api.post(`/admin/edges/${edgeId}/resume`);
      return data;
    },
    onSuccess: () => invalidateEdges(qc),
  });
}

export function useResyncEdge() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (edgeId: string): Promise<{ triggered: boolean; new_version: number }> => {
      const { data } = await api.post(`/admin/edges/${edgeId}/resync`);
      return data;
    },
    onSuccess: () => invalidateEdges(qc),
  });
}

export interface ConfigSyncStatus {
  edge_id: string;
  db_version: number;
  edge_applied_version: number | null;
  drift_count: number | null;
  is_synced: boolean;
  last_ack_at: string | null;
  last_seen_at: string | null;
}

export function useEdgeConfigSync(edgeId: string | null) {
  return useQuery({
    queryKey: edgeId ? queryKeys.edges.configSync(edgeId) : ['edges', 'config-sync', 'none'],
    queryFn: async (): Promise<ConfigSyncStatus> => {
      const { data } = await api.get<ConfigSyncStatus>(`/admin/edges/${edgeId}/config-sync-status`);
      return data;
    },
    enabled: !!edgeId,
    refetchInterval: 30_000,
  });
}

export interface EventItem {
  event_id: number;
  ts: string;
  event_kind: string;
  severity: string;
  edge_id: string | null;
  device_id: string | null;
  command_id: string | null;
  actor: string | null;
  message: string | null;
  data_json: Record<string, unknown> | null;
}

export interface EventsResponse {
  kind: string | null;
  total: number;
  items: EventItem[];
}

export function useEdgeEvents(edgeId: string | null, kind?: string, limit = 30) {
  const params = { edge_id: edgeId, kind, limit };
  return useQuery({
    queryKey: ['reports', 'events', params],
    queryFn: async (): Promise<EventsResponse> => {
      const { data } = await api.get<EventsResponse>('/reports/events', { params });
      return data;
    },
    enabled: !!edgeId,
    refetchInterval: 30_000,
  });
}
