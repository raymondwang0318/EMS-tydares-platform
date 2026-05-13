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

/**
 * 設備型號頁面（[[T-AdminUI-002]] / [[M-PM-215]] 業主決議方向 B）
 *
 * 業主 5/12 chat：「Web UI 設備型號分頁，似乎不需要存在？型號已經掛載到設備 ID 裡面了」
 * 業主觀察成立（fnd_device_model 0 row；ScanWizard 跳過機型字典；device_model_id FK NULL）
 *
 * 預設 `false` → sidebar menu 隱藏；route 保留但無入口；component code 保留
 * 啟用：`VITE_FF_DEVICE_MODELS_ENABLED=true npm run build`（業主未來啟用機型字典時）
 */
export const FF_DEVICE_MODELS_ENABLED = envFlag(
  'VITE_FF_DEVICE_MODELS_ENABLED',
  false,
);
