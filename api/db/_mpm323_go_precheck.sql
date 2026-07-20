-- M-PM-323 階段3 GO 前置採證閉環（唯讀，2026-06-17）
\pset pager off
\echo === 1. 採證閉環①：rule1/3/5 仍 hardware/auto_clear_allowed=f ===
SELECT rule_id, rule_name, category, auto_clear_allowed, enabled
FROM ems_alert_rule WHERE rule_id IN (1,3,5);
\echo === 2. 採證閉環②：ADR-028 trigger 仍在 ===
SELECT tgname, tgenabled FROM pg_trigger
WHERE tgname='trg_enforce_hardware_manual_clear' AND NOT tgisinternal;
\echo === 3. 採證閉環③：active 分布（含 acknowledged，對抗驗證漏報防護）===
SELECT a.rule_id, r.rule_name, a.status, a.auto_resolved, COUNT(*)
FROM ems_alert_active a JOIN ems_alert_rule r ON r.rule_id=a.rule_id
GROUP BY 1,2,3,4 ORDER BY 1,3,4;
\echo === 4. 🔑 GO-5 白名單：rule1 保留 3 真離線 device_id + 雙口徑 lag（防 TC04 誤清）===
SELECT a.device_id, m.display_name,
       EXTRACT(EPOCH FROM (NOW() - (SELECT MAX(t.ts) FROM trx_reading t
         WHERE t.device_id=a.device_id)))/3600 AS lag_全口徑_hr,
       EXTRACT(EPOCH FROM (NOW() - (SELECT MAX(t.ts) FROM trx_reading t
         WHERE t.device_id=a.device_id AND t.parameter_code='max_temp')))/3600 AS lag_maxtemp_hr,
       CASE WHEN EXTRACT(EPOCH FROM (NOW() - (SELECT MAX(t.ts) FROM trx_reading t
         WHERE t.device_id=a.device_id))) >= 600 OR
         (SELECT MAX(t.ts) FROM trx_reading t WHERE t.device_id=a.device_id) IS NULL
       THEN '真離線_保留' ELSE '殭屍_清' END AS 全口徑verdict
FROM ems_alert_active a
LEFT JOIN ems_ir_device_metadata m ON m.device_id=a.device_id
WHERE a.rule_id=1
ORDER BY 全口徑verdict, lag_全口徑_hr DESC NULLS FIRST;
