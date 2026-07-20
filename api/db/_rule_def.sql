SELECT rule_id, rule_name, condition_type, metric, operator, threshold_value,
       duration_sec, cooldown_sec
FROM ems_alert_rule ORDER BY rule_id;
