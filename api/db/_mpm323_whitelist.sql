-- M-PM-323 GO-5 白名單快速版（JOIN+GROUP BY，唯讀）
\pset pager off
\echo === rule1 11 台：殭屍 vs 真離線（雙口徑 lag，防 TC04 誤清）===
WITH rule1_dev AS (
  SELECT alert_id, device_id FROM ems_alert_active WHERE rule_id=1
),
lag AS (
  SELECT r.alert_id, r.device_id,
         MAX(t.ts) AS last_all,
         MAX(t.ts) FILTER (WHERE t.parameter_code='max_temp') AS last_mt
  FROM rule1_dev r
  LEFT JOIN trx_reading t ON t.device_id = r.device_id
  GROUP BY r.alert_id, r.device_id
)
SELECT lag.device_id, m.display_name,
       ROUND((EXTRACT(EPOCH FROM (NOW()-last_all))/3600)::numeric, 1) AS lag_全口徑_hr,
       ROUND((EXTRACT(EPOCH FROM (NOW()-last_mt))/3600)::numeric, 1)  AS lag_maxtemp_hr,
       CASE WHEN last_all IS NULL OR (NOW()-last_all) >= INTERVAL '600 seconds'
            THEN '真離線_保留' ELSE '殭屍_清' END AS verdict
FROM lag LEFT JOIN ems_ir_device_metadata m ON m.device_id = lag.device_id
ORDER BY verdict, lag_全口徑_hr DESC NULLS FIRST;
