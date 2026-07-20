-- =============================================================================
-- M-PM-323 軌 A：清存量殭屍 + stale（動態 verdict，保留真離線；2026-06-17）
-- =============================================================================
-- DB: VM104 192.168.10.204 原生 postgres / ems_central / role=ems / owner=postgres
-- ⚠️ 執行前 evaluator(ems-worker) 應已停（GO 批次步驟1），避免並發重 fire/撞 UNIQUE。
-- 動態判定（非硬編 TC 名單）：rule1 設備 lag<600s=殭屍 / rule5 Edge lag<180s=殭屍 /
--   rule6 auto_resolved=TRUE=stale。保留真離線（lag>=門檻 或 無資料 IS NULL）。
-- =============================================================================
\set ON_ERROR_STOP on
\pset pager off

BEGIN;

-- ── 步驟1：backup = 要刪的集合（動態 verdict 並集，JOIN+GROUP BY 快版）──
DROP TABLE IF EXISTS _alert_active_bak_20260617;
CREATE TABLE _alert_active_bak_20260617 AS
WITH r1_lag AS (
    SELECT a.alert_id, MAX(t.ts) AS last_ts
    FROM ems_alert_active a
    LEFT JOIN trx_reading t ON t.device_id = a.device_id
    WHERE a.rule_id = 1 AND a.status IN ('active','acknowledged')
    GROUP BY a.alert_id
),
zombie_ids AS (
    -- rule1 IR 殭屍：設備 trx 最新 lag<600s（已恢復；NULL=無資料→不入選=保留真離線）
    SELECT alert_id FROM r1_lag WHERE last_ts >= NOW() - INTERVAL '600 seconds'
    UNION
    -- rule5 Edge 殭屍：ems_edge.last_seen lag<180s（已復電）
    SELECT a.alert_id FROM ems_alert_active a JOIN ems_edge e ON e.edge_id = a.edge_id
    WHERE a.rule_id = 5 AND a.status IN ('active','acknowledged')
      AND e.last_seen_at >= NOW() - INTERVAL '180 seconds'
    UNION
    -- rule6 stale：auto_resolved=TRUE 但 status active
    SELECT alert_id FROM ems_alert_active
    WHERE rule_id = 6 AND status IN ('active','acknowledged') AND auto_resolved = TRUE
)
SELECT a.* FROM ems_alert_active a
WHERE a.alert_id IN (SELECT alert_id FROM zombie_ids);

-- ── 步驟2：backup 分布（人工核對 SSOT 快照；不寫死數字）──
\echo '--- backup 分布（人工核對：rule1 殭屍 / rule5 殭屍 / rule6 stale）---'
SELECT rule_id, COUNT(*) FROM _alert_active_bak_20260617 GROUP BY rule_id ORDER BY rule_id;
\echo '--- 保留的 rule1 真離線（應含 TC04/TC16 等；不在 backup 內）---'
SELECT a.device_id, a.rule_id FROM ems_alert_active a
WHERE a.rule_id = 1 AND a.alert_id NOT IN (SELECT alert_id FROM _alert_active_bak_20260617)
ORDER BY a.device_id;

-- ── 步驟3：寫 history 'cleared' 審計軌 ──
INSERT INTO ems_alert_history
    (ts, alert_id, rule_id, event_type, device_id, edge_id, severity, message, actor, note)
SELECT NOW(), alert_id, rule_id, 'cleared', device_id, edge_id, severity, message,
       'M-PM-323_cleanup',
       CASE rule_id
         WHEN 1 THEN 'rule1 IR 殭屍：設備已恢復(lag<600s)'
         WHEN 5 THEN 'rule5 Edge 斷電殭屍：fleet 已復電(lag<180s)'
         WHEN 6 THEN 'rule6 stale：auto_resolved=TRUE 未清表'
       END
FROM _alert_active_bak_20260617;

-- ── 步驟4：DELETE（USING _bak 確保刪除集合 = backup 集合，杜絕漂移）──
DELETE FROM ems_alert_active a USING _alert_active_bak_20260617 b
WHERE a.alert_id = b.alert_id;

-- ── 步驟5：清理後驗收（同 transaction）──
\echo '--- 清理後 active 殘留（預期 rule1=真離線 / rule2=16歸軌B / rule5=0 / rule6=0）---'
SELECT rule_id, COUNT(*) FROM ems_alert_active GROUP BY rule_id ORDER BY rule_id;
\echo '--- history cleared 落軌筆數（= backup 筆數）---'
SELECT COUNT(*) FROM ems_alert_history WHERE event_type='cleared' AND actor='M-PM-323_cleanup';

COMMIT;
-- rollback（已 COMMIT 後）：停 worker → TRUNCATE ems_alert_active →
--   INSERT INTO ems_alert_active SELECT * FROM _alert_active_bak_20260617 → 重啟 worker。
-- backup 表保留至驗收+7天後 DROP。
