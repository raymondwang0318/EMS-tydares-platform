-- M-PM-319 §3.1 thermal_alarm 採證（唯讀）
\echo === 1. thermal_alarm 全量統計 ===
SELECT severity, (resolved_at IS NOT NULL) AS resolved, COUNT(*),
       MIN(ts)::timestamp(0) AS first, MAX(ts)::timestamp(0) AS last
FROM ems_events WHERE event_kind = 'thermal_alarm'
GROUP BY 1, 2 ORDER BY 1, 2;
\echo === 2. 逐筆明細（device/sev/溫度/時間/解除）===
SELECT e.device_id, m.display_name, e.severity,
       e.data_json->>'max_temp_c' AS temp,
       e.ts::timestamp(0), e.resolved_at::timestamp(0),
       (e.data_json->>'recovered') AS recovered
FROM ems_events e
LEFT JOIN ems_ir_device_metadata m ON m.device_id = e.device_id
WHERE e.event_kind = 'thermal_alarm'
ORDER BY e.ts;
\echo === 3. 7 天真實 max_temp 峰值 per device ===
SELECT t.device_id, m.display_name, MAX(t.value) AS peak_7d,
       MAX(t.value) FILTER (WHERE t.ts > NOW() - INTERVAL '1 hour') AS peak_1h
FROM trx_reading t
LEFT JOIN ems_ir_device_metadata m ON m.device_id = t.device_id
WHERE t.parameter_code = 'max_temp' AND t.ts > NOW() - INTERVAL '7 days'
GROUP BY 1, 2 ORDER BY 3 DESC;
