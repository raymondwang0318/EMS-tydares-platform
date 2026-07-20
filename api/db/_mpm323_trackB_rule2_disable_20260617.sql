-- =============================================================================
-- M-PM-323 軌 B/D：rule2「IR 推送頻率異常」停用 + 清 16 噪音（2026-06-17）
-- =============================================================================
-- 鐵證：count_5min<60 假設每5s推1筆；811C 為每5min推1summary→5min窗永遠0~5列<60
--   →16/16 永久誤觸。頻率語意已由 rule1(離線)涵蓋。停用＝治本（軌 D 方案1）。
-- rule2 是 software → UPDATE enabled 不撞 trg_enforce_hardware_manual_clear。
-- =============================================================================
\set ON_ERROR_STOP on
\pset pager off

BEGIN;

-- ── 步驟1：停用 rule2（保留定義；description 用 regexp_replace 冪等防重複污染）──
UPDATE ems_alert_rule
SET enabled = FALSE,
    updated_at = NOW(),
    description = regexp_replace(COALESCE(description, ''), ' \[M-PM-323.*$', '')
                  || ' [M-PM-323 軌B/D 2026-06-17 停用：count_5min<60 對 811C 5min 聚合永久誤報；頻率語意已由 rule1 涵蓋]'
WHERE rule_id = 2 AND category = 'software';
SELECT rule_id, rule_name, enabled, deleted_at FROM ems_alert_rule WHERE rule_id = 2;

-- ── 步驟2：ASSERT 已停用（防順序顛倒：先 cleanup 後 disable 會清完又長回來）──
DO $$ BEGIN
  IF (SELECT enabled FROM ems_alert_rule WHERE rule_id = 2) <> FALSE THEN
    RAISE EXCEPTION 'rule2 still enabled — abort cleanup';
  END IF;
END $$;

-- ── 步驟3：backup 16 噪音（含 TC04 device_id 靜默型 count=0 採證價值）──
DROP TABLE IF EXISTS _alert_active_rule2_bak_20260617;
CREATE TABLE _alert_active_rule2_bak_20260617 AS
SELECT * FROM ems_alert_active
WHERE rule_id = (SELECT rule_id FROM ems_alert_rule WHERE rule_name = 'IR 推送頻率異常');
\echo '--- rule2 backup 筆數（預期 16）+ 是否含 TC04 ---'
SELECT COUNT(*) AS backed_up FROM _alert_active_rule2_bak_20260617;
SELECT device_id FROM _alert_active_rule2_bak_20260617
WHERE device_id LIKE '%92-11-55%';  -- TC04

-- ── 步驟4：DELETE（rule_name 子查詢定位，比 UPDATE 更嚴防呆）──
DELETE FROM ems_alert_active
WHERE rule_id IN (SELECT rule_id FROM ems_alert_rule WHERE rule_name = 'IR 推送頻率異常');
\echo '--- rule2 active 殘留（預期 0）---'
SELECT COUNT(*) AS rule2_after FROM ems_alert_active WHERE rule_id = 2;

COMMIT;
-- rollback：UPDATE ems_alert_rule SET enabled=TRUE WHERE rule_id=2（噪音立即復發，僅誤判時用）;
--   INSERT INTO ems_alert_active SELECT * FROM _alert_active_rule2_bak_20260617。
