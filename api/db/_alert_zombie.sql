-- M-PM-323 殭屍 vs 真實 鐵證判定（唯讀，2026-06-16）
\pset pager off
\echo === A. rule1 IR 離線 11 台：對照 trx_reading 設備真實在線狀態 ===
-- 告警 last_seen_at = evaluator 最後判定離線的時間；trx 最新 = 設備真實最後上報
SELECT COALESCE(m.display_name, a.device_id) AS target,
       a.last_seen_at::timestamp(0) AS 告警最後判離線,
       (SELECT MAX(t.ts)::timestamp(0) FROM trx_reading t
        WHERE t.device_id = a.device_id AND t.parameter_code='max_temp') AS 設備最新上報,
       EXTRACT(EPOCH FROM (NOW() - (SELECT MAX(t.ts) FROM trx_reading t
        WHERE t.device_id=a.device_id AND t.parameter_code='max_temp')))/3600 AS 斷訊小時,
       CASE WHEN (SELECT MAX(t.ts) FROM trx_reading t
        WHERE t.device_id=a.device_id AND t.parameter_code='max_temp') > NOW() - INTERVAL '20 minutes'
        THEN '✅設備在線(殭屍)' ELSE '🔴真離線' END AS 判定
FROM ems_alert_active a
LEFT JOIN ems_ir_device_metadata m ON m.device_id=a.device_id
WHERE a.rule_id=1 ORDER BY 設備最新上報 DESC NULLS LAST;

\echo === B. rule5 Edge 失聯 21 台：對照 ems_edge 真實在線狀態 ===
SELECT a.edge_id,
       a.last_seen_at::timestamp(0) AS 告警最後判失聯,
       e.last_seen_at::timestamp(0) AS edge真實最新,
       EXTRACT(EPOCH FROM (NOW() - e.last_seen_at))/60 AS 斷訊分鐘,
       CASE WHEN e.last_seen_at > NOW() - INTERVAL '5 minutes'
        THEN '✅Edge在線(殭屍)' ELSE '🔴真失聯' END AS 判定, e.status
FROM ems_alert_active a
JOIN ems_edge e ON e.edge_id=a.edge_id
WHERE a.rule_id=5 ORDER BY e.last_seen_at DESC NULLS LAST;

\echo === C. rule6 21 筆 auto_resolved=t 但 status=active（stale 殘留）===
SELECT COUNT(*) AS rule6_autoResolved_但status仍active
FROM ems_alert_active WHERE rule_id=6 AND auto_resolved=TRUE AND status='active';
