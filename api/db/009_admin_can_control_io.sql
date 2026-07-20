-- =============================================================================
-- 009_admin_can_control_io.sql
-- viewer + I/O 操作員權限（老王 2026-06-17 拍板，P11 升報 P12A 後端安全鎖）：
--   ems_admin_user 加 can_control_io 旗標。**獨立旗標綁帳號（不綁 role）**——
--   I/O 控制 endpoint（control_do + POST /commands 的 relay.set）權限＝看此旗標，
--   不論 admin/viewer。四種組合：admin能控/admin不能控/viewer+旗標能控(現場操作員)/viewer純唯讀。
-- DB: VM104 192.168.10.204 原生 postgres / ems_central / role=ems / owner=postgres
-- 安全性：ALTER ADD COLUMN NOT NULL DEFAULT FALSE（hypertable 外一般表，nullable 預設即時）。
--   現有 admin UPDATE=TRUE 保留「能控 I/O」現況（不破現有運維）；新帳號預設 FALSE 由用戶管理授予。
-- =============================================================================
\set ON_ERROR_STOP on
\pset pager off

BEGIN;

ALTER TABLE ems_admin_user ADD COLUMN IF NOT EXISTS can_control_io BOOLEAN NOT NULL DEFAULT FALSE;

-- 現有 admin 保留能控 I/O（不破現況）；viewer 維持 FALSE（要授旗標才成現場操作員）
UPDATE ems_admin_user SET can_control_io = TRUE WHERE role = 'admin';

COMMENT ON COLUMN ems_admin_user.can_control_io IS
  'I/O 控制權旗標（獨立綁帳號不綁 role，老王 2026-06-17）：TRUE=可操作 relay/DO 實體繼電器'
  '（control_do + POST /commands relay.set）；viewer+TRUE=現場操作員（唯讀但能控 I/O）。'
  '嚴格定義僅含實體繼電器動作，不含 config bump/device CRUD（那些 admin-only）。';

-- ems_admin_user 既有 GRANT 已涵蓋（007 L38 GRANT SELECT/INSERT/UPDATE/DELETE TO ems）；
-- 加欄繼承表權限，冪等重申防呆（io-settings 500 教訓）。
GRANT SELECT, INSERT, UPDATE, DELETE ON ems_admin_user TO ems;

COMMIT;

-- 驗收：
-- \d ems_admin_user                                    -- 應見 can_control_io 欄
-- SELECT username, role, can_control_io FROM ems_admin_user ORDER BY user_id;  -- admin 應 TRUE、viewer FALSE
