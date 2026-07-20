\echo === alert_active 現況（rule/device/觸發時間/最後見/auto_resolved）===
SELECT a.rule_id, r.rule_name, COALESCE(m.display_name, a.device_id, a.edge_id) AS target,
       a.severity, a.triggered_at::timestamp(0), a.last_seen_at::timestamp(0),
       a.auto_resolved, a.status
FROM ems_alert_active a
JOIN ems_alert_rule r ON r.rule_id = a.rule_id
LEFT JOIN ems_ir_device_metadata m ON m.device_id = a.device_id
ORDER BY a.severity, a.rule_id, target;
\echo === rule severity 對照 ===
SELECT rule_id, rule_name, severity, auto_clear_allowed, category FROM ems_alert_rule ORDER BY rule_id;
