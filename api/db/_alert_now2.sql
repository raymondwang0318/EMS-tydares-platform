-- M-PM-323 階段2 §0 現況採證（唯讀，2026-06-16）
\pset pager off
\echo === 1. alert_active 現況（rule/device/觸發/最後見/auto_resolved/status）===
SELECT a.rule_id, r.rule_name, r.severity, r.category,
       COALESCE(m.display_name, a.device_id, a.edge_id) AS target,
       a.triggered_at::timestamp(0) AS 觸發, a.last_seen_at::timestamp(0) AS 最後見,
       a.auto_resolved, a.status
FROM ems_alert_active a
JOIN ems_alert_rule r ON r.rule_id = a.rule_id
LEFT JOIN ems_ir_device_metadata m ON m.device_id = a.device_id
ORDER BY a.rule_id, target;
\echo === 2. alert_active 按 rule 計數（對齊 6/12 的 rule1=11/rule2=16）===
SELECT a.rule_id, r.rule_name, r.severity, COUNT(*) AS 筆數,
       MAX(a.last_seen_at)::timestamp(0) AS 最新見
FROM ems_alert_active a JOIN ems_alert_rule r ON r.rule_id=a.rule_id
GROUP BY 1,2,3 ORDER BY 1;
\echo === 3. alert_rule 全 7 條定義 ===
SELECT rule_id, rule_name, category, condition_type, metric, operator,
       threshold_value, duration_sec, cooldown_sec, auto_clear_allowed, enabled
FROM ems_alert_rule ORDER BY rule_id;
\echo === 4. ADR-028 硬體類人工解除 trigger 現況 ===
SELECT tgname, tgrelid::regclass AS 表, pg_get_triggerdef(oid) AS def
FROM pg_trigger WHERE NOT tgisinternal
  AND (tgname ILIKE '%hardware%' OR tgname ILIKE '%manual%' OR tgname ILIKE '%clear%');
\echo === 5. enforce_hardware_manual_clear 函式內容 ===
SELECT prosrc FROM pg_proc WHERE proname = 'enforce_hardware_manual_clear';
\echo === 6. alert_history 量（清理範圍評估）===
SELECT COUNT(*) AS total FROM ems_alert_history;
