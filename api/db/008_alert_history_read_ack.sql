-- =============================================================================
-- 008_alert_history_read_ack.sql
-- M-PM-323 軌C v2（老王 2026-06-17 拍板）：硬體告警（rule1/3/5）連線恢復改「直接綠燈」
--   ＝grace 後自動 DELETE active（不再標 auto_resolved=TRUE 綠燈停留待人 clear）。
--   人工治理留痕從 active「綠燈待確認」改到 ems_alert_history「人工讀取確認」——
--   人回顧告警歷史後對指定列按『已讀確認』。本 migration 為歷史表加 read_at/read_by。
-- DB: VM104 192.168.10.204 原生 postgres / ems_central / role=ems / owner=postgres
-- 對象：ems_alert_history（003 建，TimescaleDB hypertable，PK=(ts,alert_id,event_type)）
-- 安全性：ALTER ADD COLUMN nullable（DEFAULT NULL）在 hypertable 上不觸發 rewrite；
--   NULL=未讀。冪等 IF NOT EXISTS，可重複套用。
-- =============================================================================
\set ON_ERROR_STOP on
\pset pager off

BEGIN;

ALTER TABLE ems_alert_history ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;
ALTER TABLE ems_alert_history ADD COLUMN IF NOT EXISTS read_by VARCHAR(100);

COMMENT ON COLUMN ems_alert_history.read_at IS 'M-PM-323v2 人工讀取確認時間（NULL=未讀）';
COMMENT ON COLUMN ems_alert_history.read_by IS 'M-PM-323v2 讀取確認操作者帳號';

-- ── ADR-028 語意演化標註（M-PM-323v2，老王 2026-06-17 拍板）─────────────────────────
-- 本 migration「不改」ems_alert_rule.auto_clear_allowed 的值（rule1/3/5 硬體類維持 FALSE，
-- DB trigger enforce_hardware_manual_clear 仍把關），改的是 alert_evaluator 行為。
-- FALSE 自此「不再等於永不自動解除」：硬體類改為 grace 後自動 DELETE active（IR 180s/
-- Edge 300s + value≠None 把關保 TC04），人工確認移至上方 read_at/read_by。避免未來維護者
-- 只看 schema/ADR-028 誤判「硬體告警不會自動消失」而與 production 行為相反。
COMMENT ON COLUMN ems_alert_rule.auto_clear_allowed IS
  'M-PM-323v2 起語意演化：FALSE=硬體類，恢復走 grace 緩衝後自動 DELETE（非永不自動解除）；'
  'TRUE=軟體類，恢復無 grace 直接 DELETE。人工確認移至 ems_alert_history.read_at/read_by；'
  'DB trigger enforce_hardware_manual_clear 仍強制 hardware 類此欄為 FALSE。';

-- GRANT：ems_alert_history 在 003 已 OWNER TO ems（owner 天然全權），新增欄位繼承表權限，
-- 此 GRANT 對 owner 為冪等無效操作，純防禦性保留（日後 owner 若被改才有意義）。與 io-settings
-- 500（owner=postgres 漏 GRANT）情境不同，本表 owner 即 ems，無該隱患。
GRANT SELECT, INSERT, UPDATE, DELETE ON ems_alert_history TO ems;

COMMIT;

-- 驗收：
-- \d ems_alert_history                         -- 應見 read_at / read_by 兩欄
-- SELECT read_at, read_by FROM ems_alert_history LIMIT 1;   -- ems role 應可查（不報 permission denied）
