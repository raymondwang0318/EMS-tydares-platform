-- E66 清理 C/D/E（A 已完成；B 撞 enforce_hardware_manual_clear trigger＝ADR-028 既建設計，跳過）
\set ON_ERROR_STOP on

\echo === C. alert_active 全表清空（derived state；新 evaluator 30s 內重建）===
TRUNCATE ems_alert_active;

\echo === D. alert_history 保留非 E66 → TRUNCATE → 回灌 ===
CREATE TABLE _e66_hist_keep AS
  SELECT * FROM ems_alert_history WHERE edge_id IS DISTINCT FROM 'TYDARES-E66';
SELECT COUNT(*) AS keep_rows FROM _e66_hist_keep;
TRUNCATE ems_alert_history;
INSERT INTO ems_alert_history SELECT * FROM _e66_hist_keep;
DROP TABLE _e66_hist_keep;
SELECT COUNT(*) AS hist_after FROM ems_alert_history;
SELECT pg_size_pretty(hypertable_size('ems_alert_history')) AS hist_size_after;

\echo === E. E66 device/edge 殘留清除 ===
SELECT conrelid::regclass AS fk_child FROM pg_constraint WHERE confrelid = 'ems_device'::regclass;
DELETE FROM fnd_ecsu_circuit_assgn
  WHERE device_id IN (SELECT device_id FROM ems_device WHERE edge_id = 'TYDARES-E66');
DELETE FROM ems_device WHERE edge_id = 'TYDARES-E66';
DELETE FROM ems_edge WHERE edge_id = 'TYDARES-E66';
SELECT (SELECT COUNT(*) FROM ems_edge WHERE edge_id = 'TYDARES-E66') AS edge_left,
       (SELECT COUNT(*) FROM ems_device WHERE edge_id = 'TYDARES-E66') AS device_left,
       (SELECT COUNT(*) FROM ems_alert_history WHERE edge_id = 'TYDARES-E66') AS hist_left;
