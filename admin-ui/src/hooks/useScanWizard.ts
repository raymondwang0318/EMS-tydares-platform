import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '../services/api';
import { queryKeys } from '../lib/queryClient';

export interface EmsDevice {
  device_id: string;
  edge_id: string;
  device_type: string;
  device_name: string | null;
  created_at: string;
}

export type CommandStatus =
  | 'QUEUED'
  | 'DELIVERED'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'EXPIRED'
  | 'CANCELED';

export interface Command {
  command_id: string;
  edge_id: string;
  device_id: string | null;
  command_type: string;
  status: CommandStatus;
  payload_json: Record<string, unknown> | null;
  result_json: Record<string, unknown> | null;
  issued_by: string | null;
  issued_at: string;
  delivered_at: string | null;
  completed_at: string | null;
}

export interface ScanCircuit {
  circuit: string;
  configured: boolean;
  ct_pri: number;
  wire_type: string;
  measurement?: Record<string, { value: number; unit: string }>;
}

export interface ScanDevice {
  device_type: string;
  slave_id: number;
  bus_id: string;
  online: boolean;
  circuits: ScanCircuit[];
}

export interface ConfirmDeviceCircuit {
  circuit: string;
  ct_pri: number;
  wire: string;
}

export interface ConfirmDevice {
  device_id: string;
  device_type: string;
  device_name: string;
  slave_id: number;
  bus_id: string;
  circuits: ConfirmDeviceCircuit[];
}

export interface ConfirmDevicesResponse {
  command_id: string;
  created_count: number;
  device_count: number;
}

export interface CreateCommandRequest {
  device_id: string;
  command_type: string;
  payload: Record<string, unknown>;
  issued_by?: string;
}

export function useEdgeDevices(edgeId: string | null) {
  return useQuery({
    queryKey: edgeId
      ? queryKeys.devices.list({ edgeId })
      : ['devices', 'edge', 'none'],
    queryFn: async ({ signal }): Promise<EmsDevice[]> => {
      if (!edgeId) return [];
      // M-PM-123 同 useEdges 修法：abort signal + 顯式 10s timeout + console.error trace
      // 對齊老王 2026-05-06 chat 「展開 + 按鈕後子表載入中 >1 min」regression（curl 證實 backend <1ms 200 null）
      const t0 = Date.now();
      try {
        const { data } = await api.get<EmsDevice[]>(`/admin/edges/${edgeId}/devices`, {
          signal,
          timeout: 10000,
        });
        return Array.isArray(data) ? data : [];
      } catch (err) {
        console.error('[useEdgeDevices] fetch failed', {
          edgeId,
          elapsed_ms: Date.now() - t0,
          err,
        });
        throw err;
      }
    },
    enabled: !!edgeId,
    retry: 1,
    retryDelay: 500,
    staleTime: 15_000,
  });
}

export function useBootstrapEdgeDevice() {
  return useMutation({
    mutationFn: async (edgeId: string): Promise<{ device_id: string }> => {
      const { data } = await api.post<{ device_id: string }>(
        `/admin/edges/${edgeId}/devices/bootstrap`,
      );
      return data;
    },
  });
}

export function useCreateCommand() {
  return useMutation({
    mutationFn: async (req: CreateCommandRequest): Promise<{ command_id: string }> => {
      const { data } = await api.post<{ command_id: string }>('/commands', req);
      return data;
    },
  });
}

export async function fetchCommand(commandId: string): Promise<Command> {
  const { data } = await api.get<Command>(`/commands/detail/${commandId}`);
  return data;
}

export function useConfirmDevices() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      edgeId,
      devices,
    }: {
      edgeId: string;
      devices: ConfirmDevice[];
    }): Promise<ConfirmDevicesResponse> => {
      const { data } = await api.post<ConfirmDevicesResponse>(
        `/admin/edges/${edgeId}/devices/confirm`,
        { devices },
      );
      return data;
    },
    onSuccess: (_res, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.devices.list({ edgeId: vars.edgeId }) });
      qc.invalidateQueries({ queryKey: queryKeys.devices.all });
    },
  });
}

export function useRenameEdgeHostname() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ edgeId, hostname }: { edgeId: string; hostname: string }) => {
      const { data } = await api.patch(
        `/admin/edge-credentials/${edgeId}/hostname`,
        { hostname },
      );
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.edges.all });
    },
  });
}

export function useRenameDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      deviceId,
      deviceName,
    }: {
      deviceId: string;
      deviceName: string;
      edgeId: string;
    }) => {
      const { data } = await api.patch(
        `/admin/devices/${encodeURIComponent(deviceId)}/name`,
        { device_name: deviceName },
      );
      return data;
    },
    onSuccess: (_res, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.devices.list({ edgeId: vars.edgeId }) });
    },
  });
}
