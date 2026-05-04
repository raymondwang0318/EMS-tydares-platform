/**
 * irdata 合成熱力圖（M-PM-107 軌 1 frontend 遷移；遷自 platform-UI legacy）
 * 8×8 插值放大 + 色彩映射；與 ThermalDisplay 並列獨立元件（後續可選用）
 */
import { useRef, useEffect } from 'react';
import { normalizeIrdata, irdataToGrid, interpolate, tempToColor } from '../../utils/thermalProcessor';

const SCALE = 16;
const GRID = 8;
const SIZE = GRID * SCALE; // 128px
const BAR_H = 24;

export function ThermalHeatmap(props: { irdata: string | number[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const temps = normalizeIrdata(props.irdata);
    if (temps.length !== 64) return;

    const { matrix, minC, maxC } = irdataToGrid(temps);
    const up = interpolate(matrix, SCALE);
    const h = up.length;
    const w = up[0].length;

    // 熱力圖
    const imgData = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const [r, g, b] = tempToColor(up[y][x], minC, maxC);
        const i = (y * w + x) * 4;
        imgData.data[i] = r;
        imgData.data[i + 1] = g;
        imgData.data[i + 2] = b;
        imgData.data[i + 3] = 255;
      }
    }
    ctx.putImageData(imgData, 0, 0);

    // 色譜 bar
    for (let x = 0; x < SIZE; x++) {
      const t = minC + (x / SIZE) * (maxC - minC);
      const [r, g, b] = tempToColor(t, minC, maxC);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(x, SIZE, 1, BAR_H);
    }

    // 溫度標註
    ctx.font = '11px monospace';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left';
    ctx.fillText(`${minC.toFixed(1)}°C`, 2, SIZE + 4);
    ctx.textAlign = 'right';
    ctx.fillText(`${maxC.toFixed(1)}°C`, SIZE - 2, SIZE + 4);
    ctx.textAlign = 'center';
    ctx.fillText(`${((minC + maxC) / 2).toFixed(1)}°C`, SIZE / 2, SIZE + 4);
  }, [props.irdata]);

  return (
    <canvas
      ref={canvasRef}
      width={SIZE}
      height={SIZE + BAR_H}
      style={{ width: '100%', maxWidth: 320, imageRendering: 'auto', borderRadius: 4 }}
    />
  );
}
