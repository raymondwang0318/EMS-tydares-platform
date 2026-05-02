-- =====================================================
-- Migration 003: P12 alert framework + IR/Edge health rules
-- T-S11C-002 / ADR-028 落地
-- =====================================================
--
-- 內容：
-- 1. P12 警報三表最薄子集（ems_alert_rule / ems_alert_active / ems_alert_history hypertable）
--    - 沿用 [[P12_設備異常警報系統_前導文_2026-04-18]] §5.1-5.3 schema
--    - **擴 ems_alert_history.event_type CHECK** 加 'suppressed_by_edge_down'（ADR-028 §8.2 cross-cutting hook 必須）
-- 2. ems_alert_rule 加 UNIQUE(rule_name) constraint（idempotent INSERT 用）
-- 3. 種子 7 條 IR/Edge 規則（ADR-028 §8.1 完整 SQL）
-- 4. 通知管道 JSONB 暫只 ['in_app']（M-PM-083 §3.6 取捨；MQTT/Telegram 留 Phase ε）
--
-- Idempotent：再跑不會出錯（CREATE IF NOT EXISTS + ON CONFLICT DO NOTHING）
--
-- 前置：
-- - ems_ingest_inbox / trx_reading / ems_edge / ems_edge_heartbeat 已存在（ADR-026 V2-final）
-- - ems_ir_device_metadata 已存在（T-S11C-001 AC 4 / M-P12-021 交卷）
--
-- 採證 4 條（任務卡 §採證流程）通過後執行
-- =====================================================

BEGIN;

-- =====================================================
-- 1. ems_alert_rule
-- =====================================================
CREATE TABLE IF NOT EXISTS ems_alert_rule (
    rule_id         BIGSERIAL PRIMARY KEY,
    rule_name       VARCHAR(100) NOT NULL,
    description     TEXT,
    category        VARCHAR(20) NOT NULL DEFAULT 'hardware'
                    CHECK (category IN ('hardware', 'software')),
    auto_clear_allowed BOOLEAN NOT NULL DEFAULT FALSE,
    scope           VARCHAR(20) NOT NULL,
    device_id       VARCHAR(100),
    edge_id         VARCHAR(100),
    device_kind     VARCHAR(50),
    condition_type  VARCHAR(50) NOT NULL,
    metric          VARCHAR(100),
    operator        VARCHAR(10),
    threshold_value DOUBLE PRECISION,
    threshold_unit  VARCHAR(20),
    duration_sec    INTEGER DEFAULT 0,
    severity        VARCHAR(20) NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    notification_channels JSONB NOT NULL DEFAULT '[]'::jsonb,
    cooldown_sec    INTEGER DEFAULT 300,
    custom_expr     TEXT,
    created_by      VARCHAR(100),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ
);
ALTER TABLE ems_alert_rule OWNER TO ems;

-- UNIQUE(rule_name) for idempotent INSERT（migration 003 自加）
ALTER TABLE ems_alert_rule DROP CONSTRAINT IF EXISTS uq_alert_rule_name;
ALTER TABLE ems_alert_rule ADD CONSTRAINT uq_alert_rule_name UNIQUE (rule_name);

CREATE INDEX IF NOT EXISTS idx_alert_rule_enabled ON ems_alert_rule (enabled) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_alert_rule_scope ON ems_alert_rule (scope, device_id, edge_id);

-- Trigger: 硬體類別強制 auto_clear_allowed=false
CREATE OR REPLACE FUNCTION enforce_hardware_manual_clear()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.category = 'hardware' AND NEW.auto_clear_allowed = TRUE THEN
    RAISE EXCEPTION '硬體類別異常規則不允許自動 clear（請人員手動解除）';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_hardware_manual_clear ON ems_alert_rule;
CREATE TRIGGER trg_enforce_hardware_manual_clear
  BEFORE INSERT OR UPDATE ON ems_alert_rule
  FOR EACH ROW EXECUTE FUNCTION enforce_hardware_manual_clear();


-- =====================================================
-- 2. ems_alert_active
-- =====================================================
CREATE TABLE IF NOT EXISTS ems_alert_active (
    alert_id          BIGSERIAL PRIMARY KEY,
    rule_id           BIGINT NOT NULL REFERENCES ems_alert_rule(rule_id),
    device_id         VARCHAR(100),
    edge_id           VARCHAR(100),
    triggered_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    trigger_value     DOUBLE PRECISION,
    trigger_metric    VARCHAR(100),
    message           TEXT,
    severity          VARCHAR(20) NOT NULL,
    status            VARCHAR(20) NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'acknowledged')),
    acked_by          VARCHAR(100),
    acked_at          TIMESTAMPTZ,
    ack_note          TEXT,
    auto_resolved     BOOLEAN DEFAULT FALSE,
    auto_resolved_at  TIMESTAMPTZ,
    last_value        DOUBLE PRECISION,
    last_seen_at      TIMESTAMPTZ,
    notifications_sent JSONB DEFAULT '[]'::jsonb,
    UNIQUE (rule_id, device_id, edge_id)
);
ALTER TABLE ems_alert_active OWNER TO ems;

CREATE INDEX IF NOT EXISTS idx_alert_active_status ON ems_alert_active (status, severity);
CREATE INDEX IF NOT EXISTS idx_alert_active_device ON ems_alert_active (device_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_alert_active_edge_critical ON ems_alert_active (edge_id) WHERE status = 'active';


-- =====================================================
-- 3. ems_alert_history (hypertable)
-- =====================================================
-- 注意：event_type CHECK 從前導文 §5.3 原 5 種**擴展為 6 種**
-- 新增 'suppressed_by_edge_down' 對應 ADR-028 §8.2 Edge-down 抑制 hook
CREATE TABLE IF NOT EXISTS ems_alert_history (
    ts              TIMESTAMPTZ NOT NULL,
    alert_id        BIGINT NOT NULL,
    rule_id         BIGINT NOT NULL,
    event_type      VARCHAR(30) NOT NULL
                    CHECK (event_type IN (
                        'triggered',
                        'acknowledged',
                        'auto_resolved',
                        'cleared',
                        'escalated',
                        'suppressed_by_edge_down'  -- ADR-028 §8.2 新增
                    )),
    device_id       VARCHAR(100),
    edge_id         VARCHAR(100),
    value           DOUBLE PRECISION,
    message         TEXT,
    severity        VARCHAR(20),
    rule_snapshot   JSONB,
    actor           VARCHAR(100),
    note            TEXT,
    PRIMARY KEY (ts, alert_id, event_type)
);
ALTER TABLE ems_alert_history OWNER TO ems;

-- hypertable
SELECT create_hypertable(
    'ems_alert_history', 'ts',
    chunk_time_interval => INTERVAL '7 days',
    if_not_exists => TRUE
);

CREATE INDEX IF NOT EXISTS idx_alert_hist_alert ON ems_alert_history (alert_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_alert_hist_device ON ems_alert_history (device_id, ts DESC);

-- retention policy
SELECT add_retention_policy('ems_alert_history', INTERVAL '1 year', if_not_exists => TRUE);


-- =====================================================
-- 4. seed rules (ADR-028 §8.1; 7 條)
-- =====================================================
-- 通知管道暫只 'in_app'（M-PM-083 §3.6 取捨；MQTT/Telegram 留 Phase ε）

INSERT INTO ems_alert_rule
  (rule_name, description, category, auto_clear_allowed,
   scope, device_kind, condition_type, metric, operator, threshold_value, threshold_unit,
   duration_sec, severity, cooldown_sec, notification_channels)
VALUES
-- L1: IR 設備離線
('IR 設備離線', '已標記的 811C 超過 10 分鐘無新資料',
 'hardware', FALSE,
 'device_kind', '811c', 'offline', 'last_seen_received_at', '>', 600, 'second',
 180, 'critical', 600, '["in_app"]'::jsonb),
-- L2: IR 推送頻率異常
('IR 推送頻率異常', '5 分鐘窗口筆數 < 60（理論 150）',
 'software', TRUE,
 'device_kind', '811c', 'custom', 'count_5min', '<', 60, 'count',
 300, 'warning', 1800, '["in_app"]'::jsonb),
-- L3: IR 資料異常
('IR 資料異常', '溫度超出量測範圍或全像素同值（卡幀）',
 'hardware', FALSE,
 'device_kind', '811c', 'custom', 'data_validity', '==', 0, NULL,
 60, 'warning', 1800, '["in_app"]'::jsonb),
-- L4: IR 時戳漂移
('IR 時戳漂移', 'edge ts vs server received_at 差距 > 5 分鐘',
 'software', TRUE,
 'device_kind', '811c', 'custom', 'ts_drift_sec', '>', 300, 'second',
 0, 'info', 3600, '["in_app"]'::jsonb),
-- E1: Edge 主機失聯
('Edge 主機失聯', 'Edge last_seen_at 落後 > 3 分鐘',
 'hardware', FALSE,
 'edge', NULL, 'offline', 'last_seen_at', '>', 180, 'second',
 60, 'critical', 600, '["in_app"]'::jsonb),
-- E2: Edge 心跳間隔異常
('Edge 心跳間隔異常', '30 秒內無新 ems_edge_heartbeat',
 'software', TRUE,
 'edge', NULL, 'custom', 'hb_gap_sec', '>', 30, 'second',
 60, 'warning', 1800, '["in_app"]'::jsonb),
-- E3: Edge config 落後
('Edge config 落後', 'Edge 套用版本落後 DB 主版本 > 5 分鐘',
 'software', TRUE,
 'edge', NULL, 'custom', 'config_drift_sec', '>', 300, 'second',
 0, 'info', 3600, '["in_app"]'::jsonb)
ON CONFLICT (rule_name) DO NOTHING;  -- idempotent

COMMIT;

-- =====================================================
-- Post-migration sanity check
-- =====================================================
-- SELECT rule_name, scope, device_kind, condition_type, severity FROM ems_alert_rule ORDER BY rule_id;
-- 預期 7 rows
