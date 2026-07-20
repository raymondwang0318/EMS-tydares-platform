\pset pager off
\echo === read_at/read_by 欄位（應 2 列）===
SELECT column_name, data_type, is_nullable FROM information_schema.columns
WHERE table_name = 'ems_alert_history' AND column_name IN ('read_at','read_by')
ORDER BY column_name;
\echo === auto_clear_allowed COMMENT（語意演化標註）===
SELECT col_description('ems_alert_rule'::regclass,
  (SELECT ordinal_position FROM information_schema.columns
   WHERE table_name='ems_alert_rule' AND column_name='auto_clear_allowed')::int) AS comment;
\echo === ems role 可查 read 欄（不報 permission denied）===
SET ROLE ems;
SELECT COUNT(*) AS ems_can_read FROM ems_alert_history WHERE read_at IS NULL;
RESET ROLE;
