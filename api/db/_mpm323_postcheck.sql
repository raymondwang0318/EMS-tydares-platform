\pset pager off
\echo === active 分布（治本後）===
SELECT a.rule_id, r.rule_name, a.status, a.auto_resolved, COUNT(*)
FROM ems_alert_active a JOIN ems_alert_rule r ON r.rule_id=a.rule_id
GROUP BY 1,2,3,4 ORDER BY 1,3;
\echo === rule6 心跳：實際 hb_gap vs threshold 30s（採證偏緊誤報）===
SELECT a.edge_id,
       ROUND(EXTRACT(EPOCH FROM (NOW()-MAX(h.hb_ts)))::numeric,0) AS hb_gap_sec,
       a.auto_resolved
FROM ems_alert_active a
LEFT JOIN ems_edge_heartbeat h ON h.edge_id=a.edge_id
WHERE a.rule_id=6 GROUP BY a.edge_id, a.auto_resolved ORDER BY 2 DESC;
\echo === rule1 4 筆（原 3 真離線 + 動態新增？）===
SELECT a.device_id, m.display_name, a.status
FROM ems_alert_active a LEFT JOIN ems_ir_device_metadata m ON m.device_id=a.device_id
WHERE a.rule_id=1 ORDER BY a.device_id;
\echo === rule6 規則定義（threshold 30s vs 心跳 60s 偏緊）===
SELECT rule_id, rule_name, metric, operator, threshold_value, duration_sec, cooldown_sec
FROM ems_alert_rule WHERE rule_id=6;
