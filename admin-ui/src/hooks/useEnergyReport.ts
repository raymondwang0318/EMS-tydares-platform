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
      // FastAPI Query(List[str]) 接受 repeat-key（?parameter_codes=A&parameter_codes=B）
      // axios 預設陣列序列化用 bracket notation（?parameter_codes[]=A）→ 不對齊 → 必修
      // 用 URLSearchParams 手動序列化保證 repeat-key
      const params = new URLSearchParams();
      params.append('granularity', filter.granularity);
      filter.parameter_codes.forEach((c) => params.append('parameter_codes', c));
      // 故意不傳 circuit_id（即使 filter 有提供）：
      //   backend circuit_id 走 prefix LIKE，會把 ma_v_avg / ma_freq 等
      //   主迴路 metric 排除（不 match 'ba1%'）→ AEM 依迴路視角的電壓/頻率消失
      //   既然 parameter_codes 已 explicit 列出所有要的 metric，circuit_id 多餘
      //   參考 [[T-Reports-001]] AEM 視角設計（ba→ma / bb→mb 主迴路繼承）
      filter.device_ids?.forEach((d) => params.append('device_ids', d));
      params.append('from_ts', filter.from_ts);
      params.append('to_ts', filter.to_ts);
      const r = await api.get<EnergyReportResponse>(`/reports/energy?${params.toString()}`);
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
 *   - cpm12d 系列 → CPM-12D 完整 6 metric
 *   - cpm23 系列  → CPM-23 完整 6 metric（voltage 用 voltage_ll_avg 線電壓）
 *   - aem_drb 系列 + circuit_id（依迴路）→ 主迴路電壓/頻率（ma 系列 / mb 系列）+ 子迴路電流/總功率/功率因數/累積用電
 *     · ba{N}（A 排子迴路）→ voltage=ma_v_avg / frequency=ma_freq / 子迴路 ba{N}_i/_p/_pf/_ae_imp
 *     · bb{N}（B 排子迴路）→ voltage=mb_v_avg / frequency=mb_freq / 子迴路 bb{N}_i/_p/_pf/_ae_imp
 *   - aem_drb 系列 無 circuit_id（依設備）→ 主 A 排 6 metric（後續可加 ma/mb 排切換）
 *
 * 老王 2026-05-04 chat 校正：「沒有將主迴路的電壓/頻率帶入」→ 子迴路繼承對應主迴路 ma 系列 / mb 系列
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
    // AEM-DRB1 依迴路：
    //   - circuitId='ma' → 主 A 排完整 6 metric（ma_*）
    //   - circuitId='mb' → 主 B 排完整 6 metric（mb_*）
    //   - circuitId='ba{N}' → 主 A 電壓/頻率 + 子迴路 ba{N}_* 4 metric
    //   - circuitId='bb{N}' → 主 B 電壓/頻率 + 子迴路 bb{N}_* 4 metric
    // 老王 2026-05-04 chat：「ba* 子迴路帶入 ma；bb* 子迴路帶入 mb」+「Ma & Mb 也必須列入迴路選項」
    if (circuitId === 'ma') {
      return {
        voltage: 'ma_v_avg',
        frequency: 'ma_freq',
        current: 'ma_i_avg',
        power_total: 'ma_p_sum',
        power_factor: 'ma_pf',
        energy_kwh: 'ma_ae_imp',
      };
    }
    if (circuitId === 'mb') {
      return {
        voltage: 'mb_v_avg',
        frequency: 'mb_freq',
        current: 'mb_i_avg',
        power_total: 'mb_p_sum',
        power_factor: 'mb_pf',
        energy_kwh: 'mb_ae_imp',
      };
    }
    // 子迴路 ba{N} / bb{N}：繼承對應主迴路電壓/頻率 + 子迴路 4 metric
    const main = circuitId.startsWith('bb') ? 'mb' : 'ma';
    return {
      voltage: `${main}_v_avg`,
      frequency: `${main}_freq`,
      current: `${circuitId}_i`,
      power_total: `${circuitId}_p`,
      power_factor: `${circuitId}_pf`,
      energy_kwh: `${circuitId}_ae_imp`,
    };
  }
  if (deviceId.startsWith('aem_drb-')) {
    // AEM-DRB1 依設備：默認主 A 排（ma_*）6 metric；老王可切「依迴路」+ ma/mb 切換
    return {
      voltage: 'ma_v_avg',
      frequency: 'ma_freq',
      current: 'ma_i_avg',
      power_total: 'ma_p_sum',
      power_factor: 'ma_pf',
      energy_kwh: 'ma_ae_imp',
    };
  }
  // 未知 device_kind → 全 null
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
