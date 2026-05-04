/**
 * 811C 熱像顯示元件（M-PM-107 軌 1 frontend 遷移；遷自 platform-UI legacy）
 *
 * 處理流程：
 * 1. 影像處理：JPEG 320×240 → 旋轉 90° CW → 240×320 portrait
 * 2. 熱力圖處理：irdata 64 值 → 8×8 grid → 插值放大 → Iron Black 色系
 * 3. 合併顯示：JPEG 底圖 + 半透明熱力圖 + 十字標記
 */
import { useRef, useEffect, useMemo } from 'react';
import { Card } from 'antd';
import type { ThermalDisplayProps, ThermalSummary } from '../../models/thermal';
import {
  normalizeIrdata,
  computeSummary,
  parseShift,
  irdataToGrid,
  interpolate,
} from '../../utils/thermalProcessor';

export function ThermalDisplay(props: ThermalDisplayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const barRef = useRef<HTMLCanvasElement>(null);

  const summary: ThermalSummary = useMemo(() => {
    if (props.summary) return props.summary;
    return computeSummary(normalizeIrdata(props.irdata));
  }, [props.irdata, props.summary]);

  const shift = useMemo(() => parseShift(props.shift), [props.shift]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !props.image) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const temps = normalizeIrdata(props.irdata);
    const img = new Image();
    img.onload = () => {
      const origW = img.width; // 320
      const origH = img.height; // 240

      // --- Step 1: 影像處理（旋轉 90° CW） ---
      const portraitW = origH; // 240
      const portraitH = origW; // 320
      canvas.width = portraitW;
      canvas.height = portraitH;

      // --- Step 1: JPEG 旋轉 CCW + 水平翻轉 ---
      ctx.save();
      ctx.translate(0, portraitH);
      ctx.rotate(-Math.PI / 2);
      ctx.scale(-1, 1);
      ctx.translate(-origW, 0);
      ctx.drawImage(img, 0, 0);
      ctx.restore();

      // --- Step 2: 熱力圖（不旋轉，直接疊在 portrait canvas 上） ---
      const heatmap = buildHeatmap(temps);
      ctx.globalAlpha = 0.45;
      ctx.drawImage(heatmap, 0, 0, portraitW, portraitH);
      ctx.globalAlpha = 1.0;

      // --- Step 3: 十字標記（portrait 座標） ---
      drawCrosshairPortrait(ctx, summary, portraitW, portraitH);
    };

    img.src = props.image.startsWith('data:')
      ? props.image
      : `data:image/jpeg;base64,${props.image}`;

    // 色階條
    const bar = barRef.current;
    if (bar) {
      bar.width = 480;
      bar.height = 16;
      const bctx = bar.getContext('2d');
      if (bctx) {
        for (let x = 0; x < 480; x++) {
          const [r, g, b] = ironBlack(x / 480);
          bctx.fillStyle = `rgb(${r},${g},${b})`;
          bctx.fillRect(x, 0, 1, 16);
        }
      }
    }
  }, [props.image, summary, shift]);

  if (!props.image) {
    return (
      <Card>
        <div style={{ textAlign: 'center', padding: 48, color: '#999' }}>
          等待 811C 影像資料...
        </div>
      </Card>
    );
  }

  return (
    <div>
      <canvas ref={canvasRef} style={{ width: '100%', maxWidth: 480, display: 'block' }} />
      <div style={{ maxWidth: 480 }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            padding: '6px 8px',
            background: '#1a1a2e',
            fontFamily: 'monospace',
            fontWeight: 'bold',
            fontSize: 13,
          }}
        >
          <span style={{ color: '#fff' }}>MIN {summary.min_temp.toFixed(1)}°C</span>
          <span style={{ color: '#fff' }}>AVG {summary.avg_temp.toFixed(1)}°C</span>
          <span style={{ color: maxTempColor(summary.max_temp) }}>
            MAX {summary.max_temp.toFixed(1)}°C
          </span>
        </div>
        <canvas ref={barRef} style={{ width: '100%', height: 14, display: 'block' }} />
        <div style={{ height: 6, background: '#1a1a2e' }} />
      </div>
    </div>
  );
}

// ─── 溫度色彩 ───

function maxTempColor(t: number): string {
  if (t < 40) return '#ffffff';
  if (t <= 65) return '#ffcc00';
  return '#ff3333';
}

// Iron Black 色系 — 對齊原廠 iSN-811C 色階
// 白→灰→黑→深藍→紫→洋紅→橙→黃
const IRON_STOPS: [number, number, number, number][] = [
  [0.0, 255, 255, 255], // 白（最冷）
  [0.1, 180, 180, 180], // 淺灰
  [0.2, 80, 80, 80], // 深灰
  [0.3, 0, 0, 0], // 黑
  [0.4, 10, 0, 60], // 深藍
  [0.5, 60, 0, 150], // 紫
  [0.6, 160, 0, 120], // 洋紅
  [0.72, 230, 60, 0], // 橙紅
  [0.85, 255, 180, 0], // 橙黃
  [0.95, 255, 240, 80], // 亮黃
  [1.0, 255, 255, 200], // 白黃（最熱）
];

function ironBlack(ratio: number): [number, number, number] {
  const t = Math.max(0, Math.min(1, ratio));
  for (let i = 1; i < IRON_STOPS.length; i++) {
    if (t <= IRON_STOPS[i][0]) {
      const [t0, r0, g0, b0] = IRON_STOPS[i - 1];
      const [t1, r1, g1, b1] = IRON_STOPS[i];
      const f = (t - t0) / (t1 - t0);
      return [
        Math.round(r0 + (r1 - r0) * f),
        Math.round(g0 + (g1 - g0) * f),
        Math.round(b0 + (b1 - b0) * f),
      ];
    }
  }
  return [255, 255, 255];
}

// ─── Step 2: 建立熱力圖 offscreen（原始座標 320×240） ───

function buildHeatmap(temps: number[]): HTMLCanvasElement {
  const { matrix, minC, maxC } = irdataToGrid(temps);

  // col 0=右, col 7=左 → reverse 對齊 canvas x=0=左
  const flipped = matrix.map((row) => [...row].reverse());

  const scale = 32;
  const up = interpolate(flipped, scale);
  const hW = 8 * scale;
  const hH = 8 * scale;

  const offscreen = document.createElement('canvas');
  offscreen.width = hW;
  offscreen.height = hH;
  const octx = offscreen.getContext('2d')!;
  const imgData = octx.createImageData(hW, hH);

  for (let y = 0; y < hH; y++) {
    for (let x = 0; x < hW; x++) {
      const ratio = (up[y][x] - minC) / ((maxC - minC) || 1);
      const [r, g, b] = ironBlack(ratio);
      // 低溫透明，高溫不透明：alpha 隨 ratio 線性上升
      const alpha = Math.round(ratio * 255);
      const i = (y * hW + x) * 4;
      imgData.data[i] = r;
      imgData.data[i + 1] = g;
      imgData.data[i + 2] = b;
      imgData.data[i + 3] = alpha;
    }
  }
  octx.putImageData(imgData, 0, 0);
  return offscreen;
}

// ─── 十字標記（portrait canvas 座標） ───
// 熱力圖不旋轉，grid row→portrait y, grid col→portrait x
// row 0-7 上→下, col 0-7 右→左

function drawCrosshairPortrait(
  ctx: CanvasRenderingContext2D,
  summary: ThermalSummary,
  W: number,
  H: number,
) {
  if (!summary.max_coord) return;
  const { row, col } = summary.max_coord;
  const cellW = W / 8;
  const cellH = H / 8;

  // col 右→左：col 0 = 右邊 = 大 x
  const px = (7 - col) * cellW + cellW / 2;
  const py = row * cellH + cellH / 2;
  const size = 10;

  ctx.save();
  ctx.strokeStyle = '#00ccff';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(px - size, py);
  ctx.lineTo(px + size, py);
  ctx.moveTo(px, py - size);
  ctx.lineTo(px, py + size);
  ctx.stroke();

  // 溫度標籤：自動切換方向，維持在影像內
  const label = `${summary.max_temp.toFixed(1)}°C`;
  ctx.font = 'bold 11px monospace';
  const tw = ctx.measureText(label).width + 6;
  const lh = 16;

  // 水平：右邊放得下就放右邊，否則放左邊
  const lx = px + size + tw + 6 < W ? px + size + 4 : px - size - tw - 4;
  // 垂直：上方放得下就放上方，否則放下方
  const ly = py - lh - 4 > 0 ? py - lh - 4 : py + size + 4;

  ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
  ctx.fillRect(lx, ly, tw, lh);
  ctx.fillStyle = '#00ccff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, lx + 3, ly + lh / 2);
  ctx.restore();
}
