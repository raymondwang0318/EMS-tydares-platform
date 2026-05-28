/**
 * 遠端 I/O 6 場域 + 風扇模板 SSOT 對齊
 *
 * 依託：[[01_Edge/遠端IO_腳位功能模板_TCS300B03_TCS300B04]] vault SSOT v1.0
 *
 * 每場域：TCS300B03 × 3（slave 1/2/3 DI）+ TCS300B04 × 1（slave 4 DO）
 * 最大配置：6 負壓 + 3 內循環 = 9 風扇
 * 每風扇 4 DI（手動/自動/運轉/過載）+ 1 DO（自動起動）
 *
 * M-PM-240 Phase A mock 階段；M-PM-242 backend ready 後對接 real API
 */

export type FanType = 'fugu' | 'xun'; // fugu = 負壓 / xun = 內循環

export interface SiteConfig {
  code: 'Aa' | 'Ab' | 'Ae' | 'Ba' | 'Bc' | 'C';
  edge_id: string;
  edge_lan_ip: string;
  name: string;
  /** 負壓風扇數（最大 6） */
  fugu_count: number;
  /** 內循環風扇數（最大 3） */
  xun_count: number;
  /** 是否為最大配置（6+3=9）*/
  is_max: boolean;
}

/**
 * 6 場域配置（業主 5/19 ground truth；全育成基地）
 * vault SSOT §三
 */
// M-P12-078 老王 5/28：區域顯示名稱更新（code 內部 key 不動;對齊 Edge17-22 device）
//   Aa→A3 / Ab→A4 / Ae→A8 / Ba→B3 / Bc→B4 / C 保留（老王未給新名）
export const SITE_CONFIGS: SiteConfig[] = [
  { code: 'Aa', edge_id: 'TYDARES-E17', edge_lan_ip: '192.168.10.65', name: '育成-A3', fugu_count: 6, xun_count: 3, is_max: true },
  { code: 'Ab', edge_id: 'TYDARES-E18', edge_lan_ip: '192.168.10.66', name: '育成-A4', fugu_count: 4, xun_count: 2, is_max: false },
  { code: 'Ae', edge_id: 'TYDARES-E19', edge_lan_ip: '192.168.10.67', name: '育成-A8', fugu_count: 6, xun_count: 3, is_max: true },
  { code: 'Ba', edge_id: 'TYDARES-E20', edge_lan_ip: '192.168.10.68', name: '育成-B3', fugu_count: 6, xun_count: 3, is_max: true },
  { code: 'Bc', edge_id: 'TYDARES-E21', edge_lan_ip: '192.168.10.69', name: '育成-B4', fugu_count: 4, xun_count: 2, is_max: false },
  { code: 'C', edge_id: 'TYDARES-E22', edge_lan_ip: '192.168.10.70', name: '育成-C', fugu_count: 3, xun_count: 1, is_max: false },
];

/**
 * 風扇 channel mapping helper
 * 依 fan_type + fan_index 返回對應 slave + di_channel_base + do_channel
 *
 * 對齊 vault SSOT v1.0 §二.1-§二.4
 *
 * - 負壓 1-4 → slave 1 DI1-16（each 4 DI per fan：手動/自動/運轉/過載）
 * - 負壓 5-6 → slave 2 DI1-8
 * - 內循環 1-2 → slave 2 DI9-16
 * - 內循環 3 → slave 3 DI1-4
 * - DO: 負壓 1-6 → slave 4 DO1-6；循環 1-3 → slave 4 DO7-9
 */
export interface FanChannelMapping {
  slave_di: number; // 1, 2, 3
  di_channel_base: number; // DI start channel (1-based)
  do_slave: number; // always 4
  do_channel: number; // 1-9
}

export function getFanChannelMapping(fan_type: FanType, fan_index: number): FanChannelMapping {
  // DO: 負壓 1-6 → DO1-6；循環 1-3 → DO7-9
  const do_channel = fan_type === 'fugu' ? fan_index : 6 + fan_index;

  // DI mapping
  if (fan_type === 'fugu') {
    if (fan_index >= 1 && fan_index <= 4) {
      // slave 1 DI1-16 (4 fans × 4 DI each)
      return {
        slave_di: 1,
        di_channel_base: (fan_index - 1) * 4 + 1,
        do_slave: 4,
        do_channel,
      };
    }
    if (fan_index === 5 || fan_index === 6) {
      // slave 2 DI1-8 (2 fans × 4 DI each)
      return {
        slave_di: 2,
        di_channel_base: (fan_index - 5) * 4 + 1,
        do_slave: 4,
        do_channel,
      };
    }
  }
  if (fan_type === 'xun') {
    if (fan_index === 1 || fan_index === 2) {
      // slave 2 DI9-16
      return {
        slave_di: 2,
        di_channel_base: 8 + (fan_index - 1) * 4 + 1,
        do_slave: 4,
        do_channel,
      };
    }
    if (fan_index === 3) {
      // slave 3 DI1-4
      return {
        slave_di: 3,
        di_channel_base: 1,
        do_slave: 4,
        do_channel,
      };
    }
  }
  throw new Error(`Invalid fan: type=${fan_type} index=${fan_index}`);
}

/**
 * 風扇 5 狀態（vault SSOT §4.5.4）
 *
 * - auto: 自動運轉中（DI 自動 ON + DI 手動 OFF；可能 DI 運轉 ON / OFF）
 * - manual: 手動運轉中（DI 手動 ON + DI 自動 OFF）
 * - stop: 停止（DI 手動 + DI 自動 都 OFF；3-position 開關在停止位）
 * - overload: 過載警示（DI 過載 ON；OL relay 跳脫）
 * - running: 派生 — DI 運轉 ON（無論 manual/auto 模式）
 */
export interface FanStatus {
  manual: boolean;
  auto: boolean;
  running: boolean;
  overload: boolean;
  do_state: boolean;
}

export type FanMode = 'auto' | 'manual' | 'stop' | 'overload';

export function deriveFanMode(s: FanStatus): FanMode {
  if (s.overload) return 'overload';
  if (s.manual) return 'manual';
  if (s.auto) return 'auto';
  return 'stop';
}
