\echo === V1. alert_active 重建後內容 ===
SELECT a.rule_id, r.rule_name, COALESCE(a.device_id, a.edge_id) AS target,
       a.severity, a.triggered_at, a.auto_resolved
FROM ems_alert_active a JOIN ems_alert_rule r ON r.rule_id = a.rule_id
ORDER BY a.rule_id, target;
\echo === V2. 重複檢查（應 0）===
SELECT COUNT(*) - COUNT(DISTINCT (rule_id, COALESCE(device_id,''), COALESCE(edge_id,''))) AS dups
FROM ems_alert_active;
\echo === V3. history 終態 ===
SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE edge_id = 'TYDARES-E66') AS e66
FROM ems_alert_history;
\echo === V4. metadata 終態（NULL 應 0）===
SELECT COUNT(*) FILTER (WHERE edge_id IS NULL) AS null_edge FROM ems_ir_device_metadata;
