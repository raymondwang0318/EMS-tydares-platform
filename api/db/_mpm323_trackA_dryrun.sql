-- 軌 A dry-run（唯讀，ROLLBACK 不實際刪）：確認當下動態 verdict
\pset pager off
BEGIN;
CREATE TEMP TABLE _dry AS
WITH r1_lag AS (
    SELECT a.alert_id, MAX(t.ts) AS last_ts
    FROM ems_alert_active a
    LEFT JOIN trx_reading t ON t.device_id = a.device_id
    WHERE a.rule_id = 1 AND a.status IN ('active','acknowledged')
    GROUP BY a.alert_id
),
zombie_ids AS (
    SELECT alert_id FROM r1_lag WHERE last_ts >= NOW() - INTERVAL '600 seconds'
    UNION
    SELECT a.alert_id FROM ems_alert_active a JOIN ems_edge e ON e.edge_id = a.edge_id
    WHERE a.rule_id = 5 AND a.status IN ('active','acknowledged')
      AND e.last_seen_at >= NOW() - INTERVAL '180 seconds'
    UNION
    SELECT alert_id FROM ems_alert_active
    WHERE rule_id = 6 AND status IN ('active','acknowledged') AND auto_resolved = TRUE
)
SELECT a.* FROM ems_alert_active a WHERE a.alert_id IN (SELECT alert_id FROM zombie_ids);
\echo '=== 要清的分布（rule1 殭屍 / rule5 殭屍 / rule6 stale）==='
SELECT rule_id, COUNT(*) FROM _dry GROUP BY rule_id ORDER BY rule_id;
\echo '=== rule1 要清的 device（殭屍）==='
SELECT device_id FROM _dry WHERE rule_id = 1 ORDER BY device_id;
\echo '=== rule1 保留（真離線，必須含 TC04=92-11-55 / TC16=92-14-41）==='
SELECT device_id FROM ems_alert_active
WHERE rule_id = 1 AND alert_id NOT IN (SELECT alert_id FROM _dry) ORDER BY device_id;
ROLLBACK;
