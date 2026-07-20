-- =============================================================================
-- M-P11-E67 / M-P12-109 — E66 系統性殘留清理（2026-06-11，一次性維護腳本）
-- 前置：新版 alert_evaluator（排除 revoked + UPSERT 修復）已 LIVE 才可跑本腳本
-- =============================================================================
\set ON_ERROR_STOP on

\echo === A. ir metadata edge_id 補值（16 台；區域→edge 對照 per M-P11-E67 §二#1）===
BEGIN;
UPDATE ems_ir_device_metadata SET edge_id = CASE
    WHEN display_name LIKE 'D區%' THEN 'TYDARES-E04'
    WHEN display_name LIKE 'E區%' THEN 'TYDARES-E05'
    WHEN display_name LIKE 'F區%' THEN 'TYDARES-E06'
    WHEN display_name LIKE 'H區%' THEN 'TYDARES-E08'
    WHEN display_name LIKE 'I區%' THEN 'TYDARES-E09'
  END
WHERE edge_id IS NULL
  AND (display_name LIKE 'D區%' OR display_name LIKE 'E區%' OR display_name LIKE 'F區%'
       OR display_name LIKE 'H區%' OR display_name LIKE 'I區%');
SELECT edge_id, COUNT(*) FROM ems_ir_device_metadata GROUP BY edge_id ORDER BY edge_id;
COMMIT;

\echo === B. rule 1/3/5 啟用 auto_clear（恢復自動解除；M-P11-E67 補充升報）===
UPDATE ems_alert_rule SET auto_clear_allowed = TRUE WHERE rule_id IN (1, 3, 5);
SELECT rule_id, rule_name, auto_clear_allowed FROM ems_alert_rule ORDER BY rule_id;

\echo === C. alert_active 全表清空（derived state；新 evaluator 30s 內重建真實現況）===
TRUNCATE ems_alert_active;

\echo === D. alert_history 保留非 E66 → TRUNCATE → 回灌（1.9GB 回收）===
CREATE TABLE _e66_hist_keep AS
  SELECT * FROM ems_alert_history WHERE edge_id IS DISTINCT FROM 'TYDARES-E66';
SELECT COUNT(*) AS keep_rows FROM _e66_hist_keep;
TRUNCATE ems_alert_history;
INSERT INTO ems_alert_history SELECT * FROM _e66_hist_keep;
DROP TABLE _e66_hist_keep;
SELECT COUNT(*) AS hist_after FROM ems_alert_history;
SELECT pg_size_pretty(hypertable_size('ems_alert_history')) AS hist_size_after;

\echo === E. E66 device/edge 殘留清除（FK：先 binding→device→edge）===
SELECT conrelid::regclass AS fk_child FROM pg_constraint WHERE confrelid = 'ems_device'::regclass;
DELETE FROM fnd_ecsu_circuit_assgn
  WHERE device_id IN (SELECT device_id FROM ems_device WHERE edge_id = 'TYDARES-E66');
DELETE FROM ems_device WHERE edge_id = 'TYDARES-E66';
DELETE FROM ems_edge WHERE edge_id = 'TYDARES-E66';
SELECT (SELECT COUNT(*) FROM ems_edge WHERE edge_id = 'TYDARES-E66') AS edge_left,
       (SELECT COUNT(*) FROM ems_device WHERE edge_id = 'TYDARES-E66') AS device_left,
       (SELECT COUNT(*) FROM ems_alert_history WHERE edge_id = 'TYDARES-E66') AS hist_left;
