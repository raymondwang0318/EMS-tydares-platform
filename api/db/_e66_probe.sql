-- M-P11-E67 E66 殘留採證（唯讀）
\echo === 1. ems_edge E66 ===
SELECT edge_id, status, last_seen_at FROM ems_edge WHERE edge_id = 'TYDARES-E66';
\echo === 2. ems_device E66 ===
SELECT device_id, edge_id, deleted_at FROM ems_device WHERE edge_id = 'TYDARES-E66';
\echo === 3. alert_active 分布 ===
SELECT COALESCE(edge_id,'-') AS edge, rule_id, COUNT(*), MIN(triggered_at)::date AS oldest,
       MAX(last_seen_at)::date AS newest, COUNT(*) FILTER (WHERE auto_resolved) AS auto_res
FROM ems_alert_active GROUP BY 1,2 ORDER BY 3 DESC LIMIT 12;
\echo === 4. alert_active 總數 ===
SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE edge_id='TYDARES-E66') AS e66 FROM ems_alert_active;
\echo === 5. alert_history 計數+大小 ===
SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE edge_id='TYDARES-E66') AS e66 FROM ems_alert_history;
SELECT pg_size_pretty(hypertable_size('ems_alert_history')) AS hist_size;
\echo === 6. hypertable chunks ===
SELECT COUNT(*) AS chunks FROM timescaledb_information.chunks WHERE hypertable_name='ems_alert_history';
\echo === 7. ir metadata（16 台 edge_id 現況）===
SELECT device_id, display_name, edge_id FROM ems_ir_device_metadata ORDER BY device_id;
\echo === 8. ems_edge 全表 status ===
SELECT edge_id, status FROM ems_edge ORDER BY edge_id;
\echo === 9. FK 依賴 ems_edge ===
SELECT conrelid::regclass AS child, conname FROM pg_constraint
WHERE confrelid = 'ems_edge'::regclass;
\echo === 10. ems_edge_heartbeat E66 ===
SELECT COUNT(*) FROM ems_edge_heartbeat WHERE edge_id = 'TYDARES-E66';
