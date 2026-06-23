/**
 * 議題C(M-PM-341) 熱力圖 Open View — public thermal meta
 *
 * P12A 新增 GET /v1/thermal/meta（不需 auth；零敏感欄位）取代訪客會 401 的
 * /admin/edges + /admin/ir-devices，讓 Pananora iframe 訪客也能組 SSE + TC 對應。
 *   edges: [{ edge_id, last_seen_ip }]
 *   ir:    [{ device_id, display_name, edge_id, last_seen }]
 */
import { useQuery } from '@tanstack/react-query';
import api from '../services/api';

export interface ThermalMetaEdge {
  edge_id: string;
  last_seen_ip: string | null;
}

export interface ThermalMetaIr {
  device_id: string;
  display_name: string | null;
  edge_id: string | null;
  last_seen: string | null;
}

export interface ThermalMeta {
  edges: ThermalMetaEdge[];
  ir: ThermalMetaIr[];
}

export function useThermalMeta() {
  return useQuery({
    queryKey: ['thermal', 'meta'],
    queryFn: async (): Promise<ThermalMeta> => {
      // ⚠️ P12A endpoint 回傳欄位名為 ir_devices（非 ir）；hook 內統一轉為 ir 供 ThermalView 用
      const { data } = await api.get<{ edges?: ThermalMetaEdge[]; ir_devices?: ThermalMetaIr[] }>('/thermal/meta');
      return {
        edges: Array.isArray(data?.edges) ? data.edges : [],
        ir: Array.isArray(data?.ir_devices) ? data.ir_devices : [],
      };
    },
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}
