import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '../services/api';
import { queryKeys } from '../lib/queryClient';

export interface EmsDevice {
  device_id: string;
  edge_id: string;
  /**
   * V2-final backend 真實 schema 欄位（GET /v1/admin/devices 回的；對齊 ems_device.device_kind CHECK）
   * 值域：modbus_meter / thermal / relay / bacnet / other；本欄位用於 filter / 顯示
   */
  device_kind?: string;
  display_name?: string | null;
  model_id?: number | null;
  config_version?: number;
  enabled?: boolean;
  /**
   * @deprecated V1 schema；V2-final backend GET /v1/admin/devices 不回此欄位
   * useEdgeDevices queryFn 透過 transform 從 device_kind 派生（保 backward compat for ScanWizard
   * inferDefaults 既有 `device_type !== '_placeholder'` filter，本身不準確；改用 device_id prefix）
   */
  device_type?: string;
  /** @deprecated 同上；fallback 值 = display_name */
  device_name?: string | null;
  /**
   * V2-final backend 5/9 起回（P12 commit e1ccd2d）；M-PM-210/211 frontend transform 補帶
   * ISO 8601 timestamp string（含 timezone offset，如 `2026-04-24T11:26:16.846243+08:00`）
   */
  created_at?: string;
  /** 同 created_at；P12 commit e1ccd2d 補；M-PM-210/211 frontend 接 */
  updated_at?: string;
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
  /**
   * M-PM-134: backend `/v1/commands` 期待 edge_id 為 top-level field（edge-level command 必填）。
   * device.scan 是 edge-level（掃整個 RS-485 bus）；device.* 是 device-level（針對特定 device_id）。
   * 兩者擇一即可；本介面同時支援。
   */
  edge_id?: string;
  device_id?: string;
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
      // M-PM-149 / M-P11-052 採證後修：原 path `/admin/edges/{id}/devices` (V1 router) V2-final 404
      // 改用 `GET /v1/admin/devices?edge_id={id}` (v1_admin.py L263 query filter)
      // 同時 transform backend `device_kind`/`display_name` → frontend `device_type`/`device_name`
      // 保 backward compat for ScanWizard.inferDefaults（filter `_placeholder` device_id prefix）
      // 與 EdgeDevicesTable column render
      const t0 = Date.now();
      try {
        const { data } = await api.get<Array<Record<string, unknown>>>('/admin/devices', {
          params: { edge_id: edgeId },
          signal,
          timeout: 10000,
        });
        const list = Array.isArray(data) ? data : [];
        return list.map((d) => ({
          device_id: String(d.device_id ?? ''),
          edge_id: String(d.edge_id ?? edgeId),
          device_kind: d.device_kind as string | undefined,
          display_name: (d.display_name ?? null) as string | null,
          model_id: (d.model_id ?? null) as number | null,
          config_version: (d.config_version ?? 0) as number,
          enabled: (d.enabled ?? true) as boolean,
          // backward-compat alias：device_type 從 display_name / device_id 推；
          // backend V2-final 不存 fine-grained type（cpm12d/cpm23/aem_drb），用 device_kind 概括
          device_type: (d.device_kind as string | undefined) ?? '',
          device_name: (d.display_name ?? null) as string | null,
          // M-PM-210 / M-PM-211: 補 created_at + updated_at
          // backend response 已含（P12 commit e1ccd2d）；transform 漏帶 → EdgesTable「建立時間」column 永遠 '—'
          // 老王 5/9 20:40 PowerShell 採證 backend response 完整含 ISO timestamp
          created_at: (d.created_at as string | undefined) ?? undefined,
          updated_at: (d.updated_at as string | undefined) ?? undefined,
        }));
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

/**
 * T-AdminUI-005 (M-PM-188 §2.2)：ScanWizard rollback DELETE placeholder
 * - DELETE /v1/admin/devices/{device_id}（v1_admin.py L584 soft_delete_device）
 * - soft delete（set deleted_at）+ bump config_version
 * - 用於 wizard scan 失敗 / 老王取消時清 bootstrap placeholder 避免 dirty data 累積
 * - M-PM-153 ops 一次性清過 24 個；本 hook 防新累積
 */
export function useDeleteDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (deviceId: string): Promise<{ status: string }> => {
      const { data } = await api.delete<{ status: string }>(
        `/admin/devices/${deviceId}`,
      );
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.devices.all });
    },
  });
}

/**
 * M-PM-241 §2.2 / M-P11-E11: 一鍵清除全部 placeholder（業主 5/19 chat『一鍵清除全部』）
 * - 對接 M-P12-054 §2.1 backend: DELETE /v1/admin/devices/placeholders
 * - response: { status, deleted_count, remaining_count, deleted_devices: [{device_id, edge_id}] }
 * - transaction + audit log + GET filter deleted_at IS NULL 自動隱藏
 */
export interface CleanupPlaceholdersResp {
  status: string;
  deleted_count: number;
  remaining_count: number;
  deleted_devices: Array<{ device_id: string; edge_id: string }>;
}

export function useCleanupPlaceholders() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<CleanupPlaceholdersResp> => {
      const { data } = await api.delete<CleanupPlaceholdersResp>(
        '/admin/devices/placeholders',
      );
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.devices.all });
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

/**
 * M-PM-174 T-AdminUI-003: 修改 ems_edge.edge_name (業務命名；中文 OK；非 OS hostname)
 * Backend: PUT /v1/admin/edges/{edge_id} (M-P12-037 補實作；4 欄位允許：edge_name/hostname/site_code/remark_desc)
 */
export function useRenameEdgeName() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ edgeId, edgeName }: { edgeId: string; edgeName: string }) => {
      const { data } = await api.put(
        `/admin/edges/${edgeId}`,
        { edge_name: edgeName },
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
        `/admin/devices/${encodeURIComponent(deviceId)}`,
        { display_name: deviceName },
      );
      return data;
    },
    onSuccess: (_res, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.devices.list({ edgeId: vars.edgeId }) });
    },
  });
}
