-- =============================================================================
-- M-PM-323 軌 E：io_anomaly_watcher 既有誤報掛單一次性解除（2026-06-17）
-- =============================================================================
-- 鐵證：_resolve_anomaly 是 INSERT 獨立 info event，從不 UPDATE 原 error row 的
--   resolved_at。排除 5 顆風扇後 watcher 不再對它們發 resolve → 過去假告警 error
--   永掛「未解除」於事件頁。本 UPDATE 把這批歷史掛單補 resolved_at。
-- 須在 worker 部署排除常數後執行（否則 watcher 可能又補寫新的）。
-- =============================================================================
\set ON_ERROR_STOP on
\pset pager off

\echo '--- 解除前：5 顆排除風扇的未解除 error 掛單數 ---'
SELECT COUNT(*) FROM ems_events
WHERE actor = 'io_anomaly_watcher' AND severity = 'error' AND resolved_at IS NULL
  AND data_json->>'fan_id' IN ('fan_np_3','fan_np_4','fan_np_5','fan_np_6','fan_cir_3')
  AND edge_id IN ('TYDARES-E21','TYDARES-E17');

BEGIN;
UPDATE ems_events SET resolved_at = NOW()
WHERE actor = 'io_anomaly_watcher' AND severity = 'error' AND resolved_at IS NULL
  AND data_json->>'fan_id' IN ('fan_np_3','fan_np_4','fan_np_5','fan_np_6','fan_cir_3')
  AND edge_id IN ('TYDARES-E21','TYDARES-E17');
\echo '--- 解除後：應為 0 ---'
SELECT COUNT(*) FROM ems_events
WHERE actor = 'io_anomaly_watcher' AND severity = 'error' AND resolved_at IS NULL
  AND data_json->>'fan_id' IN ('fan_np_3','fan_np_4','fan_np_5','fan_np_6','fan_cir_3')
  AND edge_id IN ('TYDARES-E21','TYDARES-E17');
COMMIT;
