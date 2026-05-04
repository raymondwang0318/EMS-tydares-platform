/**
 * 811C 熱像儀資料模型（M-PM-107 軌 1 frontend 遷移；遷自 platform-UI legacy）
 * iSN-811C-MTCP: 8×8 IR + QVGA camera
 */

/** 811C 原始 payload（原廠 JSON，Edge 透傳） */
export type Thermal811CPayload = {
  macno: string;
  model: string;
  irdata: string; // 64 個整數，逗號分隔，raw ÷ 10 = °C
  shift: string; // "-30,-12" 影像對齊偏移
  image: string; // base64 JPEG（QVGA 320×240）
};

/** Edge 彙總後的溫度摘要 */
export type ThermalSummary = {
  max_temp: number;
  min_temp: number;
  avg_temp: number;
  max_coord: { row: number; col: number };
  sample_count: number;
};

/**
 * ThermalDisplay 元件的 props
 * 接受原始 811C payload，元件自行計算溫度疊加
 */
export type ThermalDisplayProps = {
  /** base64 JPEG 影像（底圖） */
  image: string;
  /** 64 個原始溫度值（raw int，÷10=°C），逗號分隔字串或數字陣列 */
  irdata: string | number[];
  /** 影像對齊偏移，格式 "-30,-12" 或 {x, y} */
  shift?: string | { x: number; y: number };
  /** 可選：預計算的摘要（來自 Edge Aggregator），省略則由元件從 irdata 計算 */
  summary?: ThermalSummary;
};
