-- =============================================================================
-- 007_admin_auth.sql — M-PM-309 admin-ui 登入權限（帳密 + session cookie）
-- =============================================================================
-- P12A (M-PM-309 階段2)；設計：_Cowork/2026-06-05_admin-ui登入權限設計_M-PM-309階段1.md
-- 老王 2026-06-05 兩決策鎖定：①走 HTTPS（Secure cookie）②verify_admin_token 雙軌 cookie OR Bearer。
--
-- 內容：
--   ① ems_admin_user（多用戶 from day 1：role/is_active 預留分級管理；MVP seed 1 admin）
--   ② ems_admin_session（24h session；secrets.token_urlsafe(32)）
--   ③ GRANT ems（io-settings 500 教訓：新表+序列必 GRANT app role）
-- rollback：兩表 DROP 即還原（verify_admin_token Bearer 路徑不受影響）。
-- 範圍：僅 admin-ui 後台維護 UI；Boss/Pananora 前台登入 OUT of scope（老王明示）。
-- =============================================================================

-- ① 管理使用者 -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ems_admin_user (
  user_id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username      VARCHAR(64) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,              -- bcrypt
  role          VARCHAR(16) NOT NULL DEFAULT 'admin',   -- RBAC 預留（分級管理未派工）
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ② session ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ems_admin_session (
  session_id   TEXT PRIMARY KEY,            -- secrets.token_urlsafe(32)
  user_id      BIGINT NOT NULL REFERENCES ems_admin_user(user_id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,        -- created + 24h
  ip_hint      VARCHAR(64),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_admin_session_expires ON ems_admin_session(expires_at);

-- ③ GRANT ems --------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON ems_admin_user, ems_admin_session TO ems;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ems;  -- IDENTITY 序列
