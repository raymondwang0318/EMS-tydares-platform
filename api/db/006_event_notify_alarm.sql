-- =============================================================================
-- 006_event_notify_alarm.sql — M-PM-313 異常履歷 API + mail 通知 + thermal 三級閾值
-- =============================================================================
-- P12A (M-PM-313 階段2 P1)；雙簽 GO 2026-06-08（M-PM-313S1）。
-- 設計：_Cowork/2026-06-08_異常履歷API_Pananora對接+mail通知_P12A設計_M-PM-313階段1.md
--
-- 內容：
--   ① ems_events 補 7 欄（source/notify_pananora/notified_at/mail_sent_at/
--      resolved_at/last_mail_sent_at/mail_send_count）— 全 nullable/default，不破既有 query
--   ② event_kind CHECK 加 'thermal_alarm'（★D3；既有約束名 = chk_event_kind，採證確認）
--   ③ ems_mail_recipient（mail 收件人）
--   ④ ems_alarm_rule（thermal 閾值 config 表；rule_type 預留未來 voltage/frequency）
--      ⚠️ 與舊 ems_alert_rule（狀態機規則引擎）範式不同，勿混用（D2）
--   ⑤ thermal 三級 seed（60 info / 75 warn / 90 critical）
--   ⑥ GRANT ems（io-settings 500 教訓：新表+序列必 GRANT app role）
-- rollback：ALTER 加欄/加 CHECK 值可還原；新表 DROP；不影響既有 events query。
-- =============================================================================

-- ① ems_events 補 7 欄 ---------------------------------------------------------
ALTER TABLE ems_events
  ADD COLUMN IF NOT EXISTS source             VARCHAR(20)  DEFAULT 'admin',  -- 'admin'/'pananora'
  ADD COLUMN IF NOT EXISTS notify_pananora    BOOLEAN      DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS notified_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS mail_sent_at       TIMESTAMPTZ,                   -- 首次發送
  ADD COLUMN IF NOT EXISTS resolved_at        TIMESTAMPTZ,                   -- NULL = 未解除
  ADD COLUMN IF NOT EXISTS last_mail_sent_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS mail_send_count    INT          DEFAULT 0;

-- ② event_kind 加 'thermal_alarm'（加值向後相容；既有列仍合法）-----------------
--    ⚠️ 採證確認既有約束名 = chk_event_kind（v2_final_schema.sql:166），非自動命名。
ALTER TABLE ems_events DROP CONSTRAINT IF EXISTS chk_event_kind;
ALTER TABLE ems_events ADD  CONSTRAINT chk_event_kind CHECK (
    event_kind IN ('command','operation','comm_abn','edge_lifecycle','config_sync','thermal_alarm')
);

-- ③ mail 收件人 ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ems_mail_recipient (
  recipient_id   SERIAL PRIMARY KEY,
  email          VARCHAR(255) UNIQUE NOT NULL,
  source         VARCHAR(20)  NOT NULL CHECK (source IN ('admin','pananora')),
  notify_enabled BOOLEAN      DEFAULT TRUE,
  description    VARCHAR(255),
  created_at     TIMESTAMPTZ  DEFAULT NOW(),
  created_by     VARCHAR(64)
);

-- ④ alarm 規則（thermal 閾值 config）------------------------------------------
--    本表為「閾值 config」；與 ems_alert_rule（狀態機規則引擎）範式不同，勿混（D2）。
CREATE TABLE IF NOT EXISTS ems_alarm_rule (
  rule_id         SERIAL PRIMARY KEY,
  rule_type       VARCHAR(30)  NOT NULL,          -- 目前只 'thermal_temp_exceed'
  device_scope    VARCHAR(30),                    -- 'all_811c'/'specific'
  device_id       VARCHAR(64),
  threshold_value NUMERIC      NOT NULL,
  threshold_unit  VARCHAR(10),                    -- 'C'
  severity        VARCHAR(20)  DEFAULT 'warn',    -- 'info'/'warn'/'critical'
  source          VARCHAR(20)  NOT NULL DEFAULT 'admin',
  enabled         BOOLEAN      DEFAULT TRUE,
  description     VARCHAR(255),
  created_at      TIMESTAMPTZ  DEFAULT NOW(),
  created_by      VARCHAR(64)
);

-- ⑤ thermal 三級 seed（老王可從 IR 標籤管理頁改）-------------------------------
INSERT INTO ems_alarm_rule (rule_type, device_scope, threshold_value, threshold_unit, severity, source, description)
SELECT * FROM (VALUES
  ('thermal_temp_exceed','all_811c', 60::numeric, 'C', 'info',     'admin', '提醒 ≥ 60°C'),
  ('thermal_temp_exceed','all_811c', 75::numeric, 'C', 'warn',     'admin', '警告 ≥ 75°C'),
  ('thermal_temp_exceed','all_811c', 90::numeric, 'C', 'critical', 'admin', '嚴重異常 ≥ 90°C → Pananora 可讀 + 發 mail')
) v(rule_type, device_scope, threshold_value, threshold_unit, severity, source, description)
WHERE NOT EXISTS (
  SELECT 1 FROM ems_alarm_rule WHERE rule_type = 'thermal_temp_exceed'
);

-- 索引：mail worker 高頻查「待通知未解除」事件 -------------------------------
CREATE INDEX IF NOT EXISTS ix_events_notify_unresolved
  ON ems_events (notify_pananora, resolved_at) WHERE notify_pananora = TRUE;

-- ⑥ GRANT ems（io-settings 500 教訓）-----------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON ems_mail_recipient, ems_alarm_rule TO ems;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ems;  -- SERIAL 序列
