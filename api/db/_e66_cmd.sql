\set ON_ERROR_STOP on
\echo === E66 commands 內容（採證）===
SELECT command_id, command_type, status, created_at FROM ems_commands
WHERE edge_id = 'TYDARES-E66' ORDER BY created_at DESC LIMIT 10;
\echo === 刪 E66 commands + edge ===
DELETE FROM ems_commands WHERE edge_id = 'TYDARES-E66';
DELETE FROM ems_edge WHERE edge_id = 'TYDARES-E66';
SELECT (SELECT COUNT(*) FROM ems_edge WHERE edge_id='TYDARES-E66') AS edge_left,
       (SELECT COUNT(*) FROM ems_commands WHERE edge_id='TYDARES-E66') AS cmd_left;
