/**
 * 前台嵌入偵測（老王 2026-06-12）
 *
 * Pananora 前台以 iframe 嵌入 admin-ui 頁（M-P12-108 Bearer 嵌入模式）。
 * 嵌入情境下隱藏「後台工程說明」類 UI（藍色提示 Alert 等），前台保持乾淨；
 * 後台直接訪問（非 iframe）不受影響。
 *
 * 用法：import { isEmbedded } from '../lib/embed';
 *      {!isEmbedded && <Alert ... />}
 */
export const isEmbedded: boolean = (() => {
  try {
    return window.self !== window.top;
  } catch {
    return true; // cross-origin 取 window.top 拋例外 = 必在 iframe 內
  }
})();
