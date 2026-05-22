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
  /** @deprecated M-PM-253 §二 老王 5/21 拍板 3「棄用實體迴路下拉」；保留 backward compat */
  circuit_id?: string;
  /** @deprecated M-PM-253 §二 棄用 device 路徑；保留 backward compat（Thermal/IR Tab 仍用）*/
  device_ids?: string[];
  /**
   * M-PM-253 §一 / M-P12-061: 走 ECSU 路徑 — backend force group_by=ecsu
   * + JOIN fnd_ecsu_circuit_assgn + SUM × sign + mapping layer per-binding
   * 給定 ecsu_id → backend 自動聚合該 ECSU 綁定的所有迴路；無需 device_ids/circuit_id
   */
  ecsu_id?: number;
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
      // M-PM-253 §二: ecsu_id 路徑（backend force group_by=ecsu + mapping layer）
      if (filter.ecsu_id != null) {
        params.append('ecsu_id', String(filter.ecsu_id));
      } else {
        // 故意不傳 circuit_id（即使 filter 有提供）：
        //   backend circuit_id 走 prefix LIKE，會把 ma_v_avg / ma_freq 等
        //   主迴路 metric 排除（不 match 'ba1%'）→ AEM 依迴路視角的電壓/頻率消失
        //   既然 parameter_codes 已 explicit 列出所有要的 metric，circuit_id 多餘
        //   參考 [[T-Reports-001]] AEM 視角設計（ba→ma / bb→mb 主迴路繼承）
        filter.device_ids?.forEach((d) => params.append('device_ids', d));
      }
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

/** 1PH / 3PH 視角（M-PM-186 §三 UI 軌新加；T-AdminUI-006 P11 session D）
 *  - CPM-23 三相 4 線電表：線電壓（voltage_ll_avg）vs 相電壓（voltage_avg）切換
 *  - CPM-12D 單相 2 線：voltage_avg 不受 phaseMode 影響
 *  - AEM-DRB1 主迴路電壓 ma_v_avg / mb_v_avg：phaseMode 不影響（per-phase 由 ma/mb 切換決定）
 */
export type PhaseMode = '1ph' | '3ph';

/**
 * 由 device_id 推斷 mapping：
 *   - cpm12d 系列 → CPM-12D 完整 6 metric（單相；phaseMode 不影響）
 *   - cpm23 系列  → CPM-23 完整 6 metric；voltage 依 phaseMode：
 *       · '3ph'（預設）→ voltage_ll_avg（線電壓）
 *       · '1ph' → voltage_avg（相電壓 = 線電壓 / √3）
 *   - aem_drb 系列 + circuit_id（依迴路）→ 主迴路電壓/頻率（ma 系列 / mb 系列）+ 子迴路電流/總功率/功率因數/累積用電
 *     · ba{N}（A 排子迴路）→ voltage=ma_v_avg / frequency=ma_freq / 子迴路 ba{N}_i/_p/_pf/_ae_imp
 *     · bb{N}（B 排子迴路）→ voltage=mb_v_avg / frequency=mb_freq / 子迴路 bb{N}_i/_p/_pf/_ae_imp
 *   - aem_drb 系列 無 circuit_id（依設備）→ 主 A 排 6 metric（後續可加 ma/mb 排切換）
 *
 * 老王 2026-05-04 chat 校正：「沒有將主迴路的電壓/頻率帶入」→ 子迴路繼承對應主迴路 ma 系列 / mb 系列
 * M-PM-186 §三（5/9）：phaseMode 加入；CPM-23 線/相電壓切換
 */
export function inferEnergyMapping(
  deviceId: string | undefined,
  circuitId?: string,
  phaseMode: PhaseMode = '3ph',
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
    // M-PM-198 §3.4 CPM-12D per-phase（driver 軌已落地 voltage_a/b/c, current_a/b/c, power_*_a/b/c）
    if (circuitId === 'l1' || circuitId === 'l2' || circuitId === 'l3') {
      const ph = circuitId === 'l1' ? 'a' : circuitId === 'l2' ? 'b' : 'c';
      return {
        voltage: `voltage_${ph}`,
        frequency: 'frequency',
        current: `current_${ph}`,
        power_total: `power_active_${ph}`,
        power_factor: `power_factor_${ph}`,
        energy_kwh: 'energy_kwh_total', // 累積電量主迴路單一；per-phase 通常無單獨累積
      };
    }
    // 主迴路（無 circuit / 'main'）
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
    // M-PM-198 §3.3 CPM-23 per-phase（driver 軌已落地 voltage_a/b/c, current_a/b/c, power_active_a/b/c, reactive/apparent/pf 各相）
    if (circuitId === 'l1' || circuitId === 'l2' || circuitId === 'l3') {
      const ph = circuitId === 'l1' ? 'a' : circuitId === 'l2' ? 'b' : 'c';
      return {
        voltage: `voltage_${ph}`,
        frequency: 'frequency',
        current: `current_${ph}`,
        power_total: `power_active_${ph}`,
        power_factor: `power_factor_${ph}`,
        energy_kwh: 'energy_kwh_imp',
      };
    }
    // 主迴路（無 circuit / 'main'）
    return {
      // M-PM-186 §三：1PH=相電壓 / 3PH=線電壓；老王校正規範 → driver 軌採證階段確認 register 命名
      voltage: phaseMode === '1ph' ? 'voltage_avg' : 'voltage_ll_avg',
      frequency: 'frequency',
      current: 'current_avg',
      power_total: 'power_total',
      power_factor: 'power_factor_avg',
      energy_kwh: 'energy_kwh_imp',
    };
  }
  if (deviceId.startsWith('aem_drb-') && circuitId) {
    // AEM-DRB1 依迴路：
    //   - circuitId='ma' / 'mb' → 主 A/B 排完整 6 metric（ma_* / mb_*）
    //   - circuitId='ma1'~'ma3' / 'mb1'~'mb3' → 主迴路 per-phase（M-PM-198 §3.1）
    //   - circuitId='ba1'~'ba12' / 'bb1'~'bb12' → 主 A/B 電壓頻率 + 子迴路 4 metric
    //   - circuitId='ba1_3' / 'ba4_6' / 'ba7_9' / 'ba10_12' / 'bb1_3' ... → 小群組（M-PM-198 §3.2）
    // 老王 5/4 chat：「ba* 子迴路帶入 ma；bb* 子迴路帶入 mb」+「Ma & Mb 也必須列入迴路選項」
    // 老王 5/9 chat（M-PM-198）：「增加 Ma1/Ma2/Ma3/Ba1-3/Ba4-6...」→ 對應 driver 軌已落地 +43 metric
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
    // 主迴路 per-phase（ma1/ma2/ma3/mb1/mb2/mb3）— M-PM-198 §3.1 driver 已落 ma_v1/i1/p1/q1/s1/pf1 等
    const perPhaseMatch = circuitId.match(/^(ma|mb)([123])$/);
    if (perPhaseMatch) {
      const [, main, n] = perPhaseMatch;
      return {
        voltage: `${main}_v${n}`,
        frequency: `${main}_freq`, // 主迴路頻率共用
        current: `${main}_i${n}`,
        power_total: `${main}_p${n}`,
        power_factor: `${main}_pf${n}`,
        energy_kwh: `${main}_ae_imp`, // 累積電量主迴路單一；per-phase 通常無單獨累積
      };
    }
    // 小群組（ba1_3 / ba4_6 / ba7_9 / ba10_12 / bb1_3 ...）— M-PM-198 §3.2 driver 已落 _i_avg / _p_sum / _q_sum / _s_sum / _pf_avg / _ae_imp
    const groupMatch = circuitId.match(/^(ba|bb)(\d+_\d+)$/);
    if (groupMatch) {
      const [, side] = groupMatch;
      const main = side === 'bb' ? 'mb' : 'ma';
      return {
        voltage: `${main}_v_avg`,   // 群組無獨立 voltage；繼承主迴路
        frequency: `${main}_freq`,  // 同上
        current: `${circuitId}_i_avg`,
        power_total: `${circuitId}_p_sum`,
        power_factor: `${circuitId}_pf_avg`,
        energy_kwh: `${circuitId}_ae_imp`,
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

// ─────────────────────────────────────────────────────────────
// Demand chart（M-PM-196 §一 / M-PM-198 同 deploy）
// driver 軌已落地：
//   CPM-23  → demand_p_sum / demand_q_sum / demand_s_sum / demand_current_a/b/c/avg
//   CPM-12D → demand_p_total / demand_q_total / demand_s_total / demand_current_a/b/c/avg
//   AEM-DRB → ma_p_dm / mb_p_dm（M-P10-040 既有）；ma/mb v_dmd/i_dmd 候選擴展
// ─────────────────────────────────────────────────────────────

export interface DemandMetricMapping {
  /** 主動需量（kW；P）*/
  p: string | null;
  /** 無效需量（kvar；Q）*/
  q: string | null;
  /** 視在需量（kVA；S）*/
  s: string | null;
}

/**
 * 由 device_id + circuitId 推 demand 三 metric
 * - CPM-23 主迴路: demand_p_sum / q_sum / s_sum
 * - CPM-12D 主迴路: demand_p_total / q_total / s_total
 * - AEM ma 主迴路: ma_p_dm（既有；q/s 候選）
 * - AEM mb 主迴路: mb_p_dm
 * - AEM 分迴路 / 小群組 / per-phase / CPM per-phase：driver 軌未落地獨立 demand → 全 null（UI 顯「—」）
 */
export function inferDemandMapping(
  deviceId: string | undefined,
  circuitId?: string,
): DemandMetricMapping {
  if (!deviceId) return { p: null, q: null, s: null };
  if (deviceId.startsWith('cpm12d-')) {
    if (!circuitId || circuitId === 'main') {
      return { p: 'demand_p_total', q: 'demand_q_total', s: 'demand_s_total' };
    }
    return { p: null, q: null, s: null }; // L1/L2/L3 沒獨立 demand
  }
  if (deviceId.startsWith('cpm23-')) {
    if (!circuitId || circuitId === 'main') {
      return { p: 'demand_p_sum', q: 'demand_q_sum', s: 'demand_s_sum' };
    }
    return { p: null, q: null, s: null }; // L1/L2/L3 沒獨立 demand
  }
  if (deviceId.startsWith('aem_drb-')) {
    if (circuitId === 'ma') return { p: 'ma_p_dm', q: null, s: null };
    if (circuitId === 'mb') return { p: 'mb_p_dm', q: null, s: null };
    if (!circuitId) return { p: 'ma_p_dm', q: null, s: null }; // 依設備預設 ma
    return { p: null, q: null, s: null };
  }
  return { p: null, q: null, s: null };
}

export function demandMappingToCodes(m: DemandMetricMapping): string[] {
  return Object.values(m).filter((v): v is string => !!v);
}

/**
 * M-PM-203：把 demand p metric 合進既有 HistoryRow[]（HistoryTable demand 欄）
 * - 對齊 ts；找出對應 row；把 avg_value 寫入 row.demand_p
 * - 若 mapping.p null → 全 row demand_p = null（顯「—」）
 * - 若 row 對應 ts 在 demandPoints 找不到 → row.demand_p = null
 */
export function mergeDemandIntoEnergyRows(
  rows: import('../components/HistoryTable').HistoryRow[],
  demandPoints: EnergyPoint[],
  demandMapping: DemandMetricMapping,
): import('../components/HistoryTable').HistoryRow[] {
  if (!demandMapping.p || rows.length === 0) {
    return rows.map((r) => ({ ...r, demand_p: null }));
  }
  // 取 demand p metric 對應 ts → value 的 map
  const tsToValue = new Map<string, number | null>();
  demandPoints.forEach((p) => {
    if (p.parameter_code !== demandMapping.p) return;
    const v = p.avg_value ?? p.last_value ?? p.first_value;
    tsToValue.set(p.ts, v);
  });
  return rows.map((r) => ({
    ...r,
    demand_p: tsToValue.get(r.ts) ?? null,
  }));
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
    // 老王 5/8 chat：「優先處理 kwh 顯示問題」+ M-PM-161 §AC 5 / M-PM-162 §4.2 規範：
    // energy_kwh 顯**累積值**（last_value 電表面板數；如 1739.x kWh）；不顯 per-period delta
    // 其他 metric 用 avg_value（既有）
    let value: number | null;
    if (metricKey === 'energy_kwh') {
      value = p.last_value ?? p.avg_value;
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
