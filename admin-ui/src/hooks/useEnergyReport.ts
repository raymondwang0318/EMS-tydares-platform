/**
 * useEnergyReport — T-Reports-001 §AC 2.3 Energy Tab hook
 *
 * 對接 P12 backend 擴充（[[M-P12-025]] §七 / [[M-PM-095]] §一）：
 *   GET /v1/reports/energy
 *     granularity:    '5min' | '15min' | '1hr' | '1day'
 *     parameter_codes: string[]   一次 call 多 metric
 *     circuit_id?:     string     prefix LIKE（'ba1' 不 match 'ba10_*'；caller 自決加 _ 邊界）
 *     device_ids?:     string[]
 *     from_ts, to_ts:  ISO 8601
 *
 * 老王 6 項用電固定順序（[[M-PM-092]] §一 / [[T-Reports-001]] §AC 2.3）：
 *   1. 電壓（voltage）
 *   2. 頻率（frequency）
 *   3. 電流（current）
 *   4. 總功率（power_total）
 *   5. 功率因數（power_factor）
 *   6. 累積用電（energy_kwh）
 *
 * 注意（M-P12-025 §7.2）：
 *   - 5min/1hr 路徑 first_value/last_value/energy_delta = null（UI fallback）
 *   - granularity=5min + group_by=ecsu → 422（前端強制 device）
 *   - alias daily→1day / monthly→1month 自動處理
 */
import { useQuery } from '@tanstack/react-query';
import api from '../services/api';
import type { Granularity } from '../components/HistoryTable';

/** 後端回的單一 point（一 ts × 一 metric × 一 group_key）*/
export interface EnergyPoint {
  ts: string;
  group_key: string; // 通常 device_id；若 group_by=ecsu 則 ecsu_id
  parameter_code: string;
  avg_value: number | null;
  min_value: number | null;
  max_value: number | null;
  first_value: number | null;
  last_value: number | null;
  energy_delta: number | null;
}

export interface EnergyReportResponse {
  granularity: Granularity | string; // alias 自動轉
  group_by: string;
  from_ts: string;
  to_ts: string;
  points: EnergyPoint[];
}

export interface EnergyReportFilter {
  granularity: Granularity;
  parameter_codes: string[];
  circuit_id?: string;
  device_ids?: string[];
  from_ts: string;
  to_ts: string;
}

export function useEnergyReport(filter: EnergyReportFilter | null) {
  return useQuery({
    queryKey: ['reports', 'energy', filter],
    enabled: !!filter && filter.parameter_codes.length > 0 && !!filter.from_ts && !!filter.to_ts,
    queryFn: async () => {
      if (!filter) return null;
      const r = await api.get<EnergyReportResponse>('/reports/energy', {
        params: {
          granularity: filter.granularity,
          parameter_codes: filter.parameter_codes,
          circuit_id: filter.circuit_id,
          device_ids: filter.device_ids,
          from_ts: filter.from_ts,
          to_ts: filter.to_ts,
        },
      });
      return r.data;
    },
    staleTime: 30_000,
  });
}

// ─────────────────────────────────────────────────────────────
// Energy 6 metric mapping per device_kind / circuit
// ─────────────────────────────────────────────────────────────

/** 老王指定 6 項 column key（固定順序）*/
export type EnergyMetricKey =
  | 'voltage'
  | 'frequency'
  | 'current'
  | 'power_total'
  | 'power_factor'
  | 'energy_kwh';

export interface EnergyMetricMapping {
  /** key=老王指定 6 項；value=後端 parameter_code（null 表示該 device/視角無對應 metric）*/
  voltage: string | null;
  frequency: string | null;
  current: string | null;
  power_total: string | null;
  power_factor: string | null;
  energy_kwh: string | null;
}

/**
 * 由 device_id 推斷 mapping：
 *   - cpm12d-* → CPM-12D 完整 6 metric
 *   - cpm23-*  → CPM-23 完整 6 metric（voltage 用 voltage_ll_avg 線電壓）
 *   - aem_drb-* + circuit_id（依迴路）→ ba{N}_* 4 metric（voltage/frequency 設備級無；null）
 *   - aem_drb-* 無 circuit_id（依設備）→ 全 null（無 device-level metric；UI 顯 placeholder）
 */
export function inferEnergyMapping(
  deviceId: string | undefined,
  circuitId?: string,
): EnergyMetricMapping {
  if (!deviceId) {
    return {
      voltage: null,
      frequency: null,
      current: null,
      power_total: null,
      power_factor: null,
      energy_kwh: null,
    };
  }
  if (deviceId.startsWith('cpm12d-')) {
    return {
      voltage: 'voltage_avg',
      frequency: 'frequency',
      current: 'current_avg',
      power_total: 'power_total',
      power_factor: 'power_factor_avg',
      energy_kwh: 'energy_kwh_total',
    };
  }
  if (deviceId.startsWith('cpm23-')) {
    return {
      voltage: 'voltage_ll_avg',
      frequency: 'frequency',
      current: 'current_avg',
      power_total: 'power_total',
      power_factor: 'power_factor_avg',
      energy_kwh: 'energy_kwh_imp',
    };
  }
  if (deviceId.startsWith('aem_drb-') && circuitId) {
    // AEM-DRB1 依迴路：ba{N}_i / ba{N}_p / ba{N}_pf / ba{N}_ae_imp
    // 注意：電壓 / 頻率為設備級；AEM 無 device-level voltage / frequency metric → null
    return {
      voltage: null,
      frequency: null,
      current: `${circuitId}_i`,
      power_total: `${circuitId}_p`,
      power_factor: `${circuitId}_pf`,
      energy_kwh: `${circuitId}_ae_imp`,
    };
  }
  // AEM 依設備（無 circuit_id）或未知 device_kind → 全 null
  return {
    voltage: null,
    frequency: null,
    current: null,
    power_total: null,
    power_factor: null,
    energy_kwh: null,
  };
}

/** 取 mapping 中所有 non-null parameter_code（用於 fetch parameter_codes 參數）*/
export function mappingToParameterCodes(mapping: EnergyMetricMapping): string[] {
  return Object.values(mapping).filter((v): v is string => !!v);
}

/**
 * 把 EnergyPoint[] 轉成 HistoryRow[]（每 row 對應一 ts；6 column 對應 mapping）
 * 5min/1hr 路徑：avg_value（first/last/energy_delta=null fallback）
 * 15min/1day 路徑：energy 欄位優先 energy_delta（累積差）；其他 metric 用 avg_value
 */
export function energyPointsToRows(
  points: EnergyPoint[],
  mapping: EnergyMetricMapping,
): import('../components/HistoryTable').HistoryRow[] {
  // group by ts
  const byTs = new Map<string, Record<string, number | null>>();

  // reverse mapping：parameter_code → metric key
  const codeToKey = new Map<string, EnergyMetricKey>();
  (Object.entries(mapping) as Array<[EnergyMetricKey, string | null]>).forEach(([key, code]) => {
    if (code) codeToKey.set(code, key);
  });

  points.forEach((p) => {
    const metricKey = codeToKey.get(p.parameter_code);
    if (!metricKey) return; // 未在 mapping 中的 metric 略過
    const row = byTs.get(p.ts) ?? {};
    // energy_kwh 偏好 energy_delta（累積差）；其他用 avg_value
    let value: number | null;
    if (metricKey === 'energy_kwh') {
      value = p.energy_delta ?? p.avg_value;
    } else {
      value = p.avg_value ?? p.last_value ?? p.first_value;
    }
    row[metricKey] = value;
    byTs.set(p.ts, row);
  });

  return Array.from(byTs.entries()).map(([ts, metrics]) => ({
    ts,
    voltage: metrics.voltage ?? null,
    frequency: metrics.frequency ?? null,
    current: metrics.current ?? null,
    power_total: metrics.power_total ?? null,
    power_factor: metrics.power_factor ?? null,
    energy_kwh: metrics.energy_kwh ?? null,
  }));
}
