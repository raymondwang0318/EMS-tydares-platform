/**
 * 811C 溫度工具函式（M-PM-107 軌 1 frontend 遷移；遷自 platform-UI legacy）
 * ADR-025: UI 不做插值合成，只做數值解析與摘要計算
 */
import type { ThermalSummary } from '../models/thermal';

/** 解析 irdata 字串 "210,213,228,..." 為溫度陣列（°C） */
export function parseIrdataString(irdata: string): number[] {
  return irdata.split(',').map((v) => parseInt(v.trim(), 10) / 10);
}

/** 標準化 irdata：字串轉數字陣列，數字陣列直接回傳 */
export function normalizeIrdata(irdata: string | number[]): number[] {
  if (typeof irdata === 'string') return parseIrdataString(irdata);
  return irdata;
}

/**
 * 從 64 個溫度值計算摘要
 * 座標系：grid[row][col] = irdata[col * 8 + row]
 *   row 0-7（上→下），col 0-7（右→左）
 */
export function computeSummary(temps: number[]): ThermalSummary {
  let max = -Infinity;
  let min = Infinity;
  let sum = 0;
  let maxIdx = 0;

  for (let i = 0; i < temps.length; i++) {
    if (temps[i] > max) {
      max = temps[i];
      maxIdx = i;
    }
    if (temps[i] < min) min = temps[i];
    sum += temps[i];
  }

  // irdata[col * 8 + row] → col = floor(idx/8), row = idx % 8
  const col = Math.floor(maxIdx / 8);
  const row = maxIdx % 8;

  return {
    max_temp: max,
    min_temp: min,
    avg_temp: sum / temps.length,
    max_coord: { row, col },
    sample_count: temps.length,
  };
}

/**
 * irdata → 8×8 溫度矩陣
 * grid[row][col] = irdata[col * 8 + row]
 */
export function irdataToGrid(temps: number[]): {
  matrix: number[][];
  minC: number;
  maxC: number;
} {
  let minC = Infinity;
  let maxC = -Infinity;
  const matrix: number[][] = [];
  for (let row = 0; row < 8; row++) {
    const rowData: number[] = [];
    for (let col = 0; col < 8; col++) {
      const t = temps[col * 8 + row];
      rowData.push(t);
      if (t < minC) minC = t;
      if (t > maxC) maxC = t;
    }
    matrix.push(rowData);
  }
  return { matrix, minC, maxC };
}

/** 雙線性插值：8×8 → (8*scale)×(8*scale) */
export function interpolate(matrix: number[][], scale: number): number[][] {
  const srcH = matrix.length;
  const srcW = matrix[0].length;
  const dstH = srcH * scale;
  const dstW = srcW * scale;
  const result: number[][] = [];
  for (let y = 0; y < dstH; y++) {
    const row: number[] = [];
    const srcY = (y / dstH) * (srcH - 1);
    const y0 = Math.floor(srcY);
    const y1 = Math.min(y0 + 1, srcH - 1);
    const fy = srcY - y0;
    for (let x = 0; x < dstW; x++) {
      const srcX = (x / dstW) * (srcW - 1);
      const x0 = Math.floor(srcX);
      const x1 = Math.min(x0 + 1, srcW - 1);
      const fx = srcX - x0;
      row.push(
        matrix[y0][x0] * (1 - fx) * (1 - fy) +
          matrix[y0][x1] * fx * (1 - fy) +
          matrix[y1][x0] * (1 - fx) * fy +
          matrix[y1][x1] * fx * fy,
      );
    }
    result.push(row);
  }
  return result;
}

/** 溫度 → RGB（藍→青→綠→黃→紅） */
export function tempToColor(t: number, min: number, max: number): [number, number, number] {
  const ratio = Math.max(0, Math.min(1, (t - min) / ((max - min) || 1)));
  let r: number;
  let g: number;
  let b: number;
  if (ratio < 0.25) {
    const f = ratio / 0.25;
    r = 0;
    g = Math.round(255 * f);
    b = 255;
  } else if (ratio < 0.5) {
    const f = (ratio - 0.25) / 0.25;
    r = 0;
    g = 255;
    b = Math.round(255 * (1 - f));
  } else if (ratio < 0.75) {
    const f = (ratio - 0.5) / 0.25;
    r = Math.round(255 * f);
    g = 255;
    b = 0;
  } else {
    const f = (ratio - 0.75) / 0.25;
    r = 255;
    g = Math.round(255 * (1 - f));
    b = 0;
  }
  return [r, g, b];
}

/** 解析 shift 字串 "-30,-12" → { x, y } */
export function parseShift(
  shift: string | { x: number; y: number } | undefined,
): { x: number; y: number } {
  if (!shift) return { x: 0, y: 0 };
  if (typeof shift === 'object') return shift;
  const parts = shift.split(',').map(Number);
  if (parts.length === 2 && parts.every((n) => !isNaN(n))) {
    return { x: parts[0], y: parts[1] };
  }
  return { x: 0, y: 0 };
}
