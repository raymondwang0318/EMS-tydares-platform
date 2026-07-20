SELECT pid, now() - query_start AS dur, state, LEFT(query, 120) AS q
FROM pg_stat_activity
WHERE datname = 'ems_central' AND state <> 'idle'
ORDER BY query_start;
