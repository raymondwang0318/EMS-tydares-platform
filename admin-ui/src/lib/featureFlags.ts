/**
 * Feature flags — admin-ui 範圍（[[T-Reports-001]] §AC 2.1）
 *
 * 設計：純前端編譯期 flag（Vite ENV `VITE_FF_*`）。
 * 預設值對齊產品決策：
 *   - LineChart：false（[[T-Reports-001]] 老王明示「折線圖代碼保留 + 預設不顯示；分析比對需求啟用」）
 *
 * 啟用方式：build 時 `VITE_FF_REPORTS_LINECHART_ENABLED=true npm run build`，
 * 或 .env / .env.local 加入。
 */

function envFlag(key: string, defaultValue: boolean): boolean {
  const raw = import.meta.env[key as keyof ImportMetaEnv];
  if (raw === undefined || raw === null || raw === '') return defaultValue;
  if (typeof raw === 'boolean') return raw;
  return String(raw).toLowerCase() === 'true' || String(raw) === '1';
}

/** Reports Energy / Thermal Tab 折線圖；[[T-Reports-001]] 業主分析比對用 */
export const FF_REPORTS_LINECHART_ENABLED = envFlag(
  'VITE_FF_REPORTS_LINECHART_ENABLED',
  false,
);
