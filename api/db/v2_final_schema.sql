-- =============================================================================
-- Tydares EMS Central — V2-final Schema (ADR-026)
-- =============================================================================
-- 依據：ADR-026 VM104 × Edge V2-final 精煉決議（2026-04-17）
-- 取代：001_initial_schema.sql（已 deprecated）、002_thermal_summary.sql
-- 目標：17 張實體表 + 5 個 continuous aggregate + LISTEN/NOTIFY trigger
--
-- 執行方式（測試期大刀一波）：
--   psql -h 192.168.10.204 -U ems -d ems_central -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
--   psql -h 192.168.10.204 -U ems -d ems_central -f v2_final_schema.sql
--
-- 命名規則：
--   ems_*  → 核心運行表（Edge 觸碰）
--   fnd_*  → 配置/字典表（UI/Admin 觸碰）
--   trx_*  → 時序/事件表（hypertable + CA）
-- =============================================================================

BEGIN;

-- =============================================================================
-- EXTENSIONS
-- =============================================================================
CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =============================================================================
-- LAYER A — 核心運行表（ems_*）8 張
-- =============================================================================

-- A1: ems_edge — 合併 Edge 基本資料 + ADR-021 credential
CREATE TABLE ems_edge (
    edge_id               VARCHAR(64)  PRIMARY KEY,
    edge_name             VARCHAR(200),
    site_code             VARCHAR(64),                    -- 站點代碼（多站點用）
    hostname              VARCHAR(128),
    token_hash            VARCHAR(128) NOT NULL,
    fingerprint           VARCHAR(128),
    previous_fingerprints JSONB        DEFAULT '[]'::jsonb,  -- 歷史指紋稽核
    status                VARCHAR(20)  NOT NULL DEFAULT 'pending',
    last_seen_ip          VARCHAR(45),
    last_seen_at          TIMESTAMPTZ,
    config_version        BIGINT       NOT NULL DEFAULT 0,  -- Edge 已套用版本
    registered_at         TIMESTAMPTZ  DEFAULT NOW(),
    approved_at           TIMESTAMPTZ,
    approved_by           VARCHAR(128),
    maintenance_at        TIMESTAMPTZ,
    replaced_at           TIMESTAMPTZ,
    revoked_at            TIMESTAMPTZ,
    revoked_reason        TEXT,
    remark_desc           VARCHAR(500),
    created_at            TIMESTAMPTZ  DEFAULT NOW() NOT NULL,
    updated_at            TIMESTAMPTZ  DEFAULT NOW() NOT NULL,
    CONSTRAINT chk_edge_status
        CHECK (status IN ('pending','approved','maintenance','pending_replace','revoked'))
);

CREATE INDEX ix_edge_status ON ems_edge(status);

-- A2: ems_edge_heartbeat — 純時序 hypertable
CREATE TABLE ems_edge_heartbeat (
    edge_id              VARCHAR(64)  NOT NULL,
    hb_ts                TIMESTAMPTZ  NOT NULL,
    ip_addr              VARCHAR(64),
    config_version       BIGINT,                -- Edge 當下套用的 config 版本
    config_applied_at    TIMESTAMPTZ,
    payload_json         JSONB,
    PRIMARY KEY (edge_id, hb_ts)
);
SELECT create_hypertable('ems_edge_heartbeat', 'hb_ts',
    chunk_time_interval => INTERVAL '7 days');

-- A3: ems_device — 設備共通欄位（supertype）
CREATE TABLE ems_device (
    device_id             VARCHAR(64)  PRIMARY KEY,
    edge_id               VARCHAR(64)  NOT NULL REFERENCES ems_edge(edge_id),
    device_kind           VARCHAR(32)  NOT NULL,  -- modbus_meter | thermal | relay | ...
    display_name          VARCHAR(200),
    model_id              BIGINT,                 -- 可空；modbus 類才關聯 fnd_device_model
    config_version        BIGINT       NOT NULL DEFAULT 0,  -- 此 device 配置版本
    enabled               BOOLEAN      DEFAULT TRUE NOT NULL,
    deleted_at            TIMESTAMPTZ,            -- 軟刪除
    remark_desc           VARCHAR(500),
    created_at            TIMESTAMPTZ  DEFAULT NOW() NOT NULL,
    updated_at            TIMESTAMPTZ  DEFAULT NOW() NOT NULL,
    CONSTRAINT chk_device_kind
        CHECK (device_kind IN ('modbus_meter','thermal','relay','bacnet','other'))
);

CREATE INDEX ix_device_edge_kind ON ems_device(edge_id, device_kind) WHERE deleted_at IS NULL;

-- A4: ems_device_modbus — Modbus 專屬子表（subtype）
CREATE TABLE ems_device_modbus (
    device_id             VARCHAR(64)  PRIMARY KEY REFERENCES ems_device(device_id) ON DELETE CASCADE,
    slave_id              INTEGER      NOT NULL,
    bus_id                VARCHAR(32),              -- RS-485 bus 識別（多 bus 時用）
    transport             VARCHAR(16)  NOT NULL DEFAULT 'rtu',  -- rtu | tcp
    tcp_host              VARCHAR(64),
    tcp_port              INTEGER,
    poll_interval_sec     INTEGER      NOT NULL DEFAULT 30,
    endianness            VARCHAR(16)  DEFAULT 'big',   -- big | word_swap
    CONSTRAINT chk_modbus_transport CHECK (transport IN ('rtu','tcp')),
    CONSTRAINT chk_modbus_slave CHECK (slave_id BETWEEN 1 AND 247)
);

-- A5: ems_device_thermal — 熱像子表（Phase 1 實作，V2-final 階段保留骨架）
CREATE TABLE ems_device_thermal (
    device_id         VARCHAR(64)  PRIMARY KEY REFERENCES ems_device(device_id) ON DELETE CASCADE,
    camera_model      VARCHAR(64),
    mac_addr          VARCHAR(32),
    zone_count        INTEGER      DEFAULT 1,
    upload_interval_sec INTEGER    DEFAULT 5
);

-- A6: ems_ingest_inbox — 冪等緩衝（1 小時保留，非 SSOT）
CREATE TABLE ems_ingest_inbox (
    idemp_key       VARCHAR(128)    PRIMARY KEY,
    edge_id         VARCHAR(64)     NOT NULL REFERENCES ems_edge(edge_id),
    device_id       VARCHAR(64),                    -- 可空（ir 類 device_id 可為 "_all"）
    source_type     VARCHAR(32)     NOT NULL,       -- modbus | ir | relay_state
    msg_ts          TIMESTAMPTZ     NOT NULL,
    received_at     TIMESTAMPTZ     DEFAULT NOW() NOT NULL,
    processed_at    TIMESTAMPTZ,                    -- worker 展平後填入
    payload_json    JSONB           NOT NULL
);

CREATE INDEX ix_inbox_unprocessed ON ems_ingest_inbox(received_at) WHERE processed_at IS NULL;
CREATE INDEX ix_inbox_edge_received ON ems_ingest_inbox(edge_id, received_at);

-- A7: ems_commands — 指令主表
CREATE TABLE ems_commands (
    command_id       VARCHAR(128)   PRIMARY KEY,
    edge_id          VARCHAR(64)    NOT NULL REFERENCES ems_edge(edge_id),
    device_id        VARCHAR(64)    REFERENCES ems_device(device_id),
    command_type     VARCHAR(64)    NOT NULL,       -- relay.set | device.scan | device.configure ...
    payload_json     JSONB,
    result_json      JSONB,
    status           VARCHAR(32)    NOT NULL DEFAULT 'QUEUED',
    priority         INTEGER        DEFAULT 50 NOT NULL,
    not_before_ts    TIMESTAMPTZ,
    expire_ts        TIMESTAMPTZ,
    idempotency_key  VARCHAR(128),
    issued_by        VARCHAR(128),
    created_at       TIMESTAMPTZ    DEFAULT NOW() NOT NULL,
    updated_at       TIMESTAMPTZ    DEFAULT NOW() NOT NULL,
    CONSTRAINT chk_commands_status CHECK (
        status IN ('QUEUED','DELIVERED','RUNNING','SUCCEEDED','FAILED','EXPIRED','CANCELED')
    )
);

CREATE UNIQUE INDEX uk_commands_idemp ON ems_commands(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX ix_commands_poll ON ems_commands(edge_id, priority, created_at) WHERE status = 'QUEUED';

-- A8: ems_events — 統一事件 hypertable（command / operation / comm_abn / edge_lifecycle）
CREATE TABLE ems_events (
    event_id        BIGINT         GENERATED ALWAYS AS IDENTITY,
    ts              TIMESTAMPTZ    DEFAULT NOW() NOT NULL,
    event_kind      VARCHAR(32)    NOT NULL,   -- command | operation | comm_abn | edge_lifecycle
    severity        VARCHAR(16)    NOT NULL DEFAULT 'info',  -- info | warn | error | critical
    edge_id         VARCHAR(64),
    device_id       VARCHAR(64),
    command_id      VARCHAR(128),
    actor           VARCHAR(128),   -- 人或系統識別（UI 操作者 / edge hostname / system）
    message         VARCHAR(2000),
    data_json       JSONB,
    PRIMARY KEY (event_id, ts),
    CONSTRAINT chk_event_kind CHECK (
        event_kind IN ('command','operation','comm_abn','edge_lifecycle','config_sync')
    ),
    CONSTRAINT chk_event_severity CHECK (
        severity IN ('info','warn','error','critical')
    )
);

SELECT create_hypertable('ems_events', 'ts',
    chunk_time_interval => INTERVAL '7 days');

CREATE INDEX ix_events_kind_ts ON ems_events(event_kind, ts DESC);
CREATE INDEX ix_events_edge_ts ON ems_events(edge_id, ts DESC) WHERE edge_id IS NOT NULL;
CREATE INDEX ix_events_command ON ems_events(command_id, ts) WHERE command_id IS NOT NULL;

-- A8.1: NOTIFY trigger — event 插入時發 channel `ems_event_<kind>`
CREATE OR REPLACE FUNCTION fn_notify_event() RETURNS trigger AS $$
BEGIN
    PERFORM pg_notify(
        'ems_event_' || NEW.event_kind,
        json_build_object(
            'event_id', NEW.event_id,
            'ts', NEW.ts,
            'severity', NEW.severity,
            'edge_id', NEW.edge_id,
            'device_id', NEW.device_id,
            'command_id', NEW.command_id,
            'message', NEW.message
        )::text
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_notify_event
    AFTER INSERT ON ems_events
    FOR EACH ROW EXECUTE FUNCTION fn_notify_event();

-- =============================================================================
-- LAYER B — 配置/字典表（fnd_*）7 張
-- =============================================================================

-- B1: fnd_config — 系統設定（Callback 欄位已拔）
CREATE TABLE fnd_config (
    config_id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    config_code      VARCHAR(50)  UNIQUE NOT NULL,
    config_name      VARCHAR(150),
    config_value     TEXT,
    remark_desc      VARCHAR(500),
    created_at       TIMESTAMPTZ  DEFAULT NOW(),
    updated_at       TIMESTAMPTZ  DEFAULT NOW()
);

-- B2: fnd_electric_parameter — 電力參數字典
CREATE TABLE fnd_electric_parameter (
    electric_parameter_id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    parameter_code          VARCHAR(50)  UNIQUE NOT NULL,
    parameter_name          VARCHAR(150) NOT NULL,
    uom_name                VARCHAR(30),
    data_type               VARCHAR(30),
    decimal_place           INTEGER,
    parameter_category      VARCHAR(30),   -- voltage | current | power | energy | thd | demand
    display_seq             INTEGER,
    remark_desc             VARCHAR(500),
    created_at              TIMESTAMPTZ  DEFAULT NOW(),
    updated_at              TIMESTAMPTZ  DEFAULT NOW()
);

-- B3: fnd_device_model — 設備型號 library（Model→Circuit→Parameter 三層）
CREATE TABLE fnd_device_model (
    model_id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    model_code       VARCHAR(50)  UNIQUE NOT NULL,
    model_name       VARCHAR(150) NOT NULL,
    model_kind       VARCHAR(32)  NOT NULL,  -- modbus_meter | thermal | ...
    vendor           VARCHAR(100),
    slave_id_default INTEGER,
    remark_desc      VARCHAR(500),
    created_at       TIMESTAMPTZ  DEFAULT NOW(),
    updated_at       TIMESTAMPTZ  DEFAULT NOW()
);

-- B4: fnd_device_model_circuit — 型號的迴路定義
CREATE TABLE fnd_device_model_circuit (
    circuit_id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    model_id         BIGINT NOT NULL REFERENCES fnd_device_model(model_id) ON DELETE CASCADE,
    circuit_code     VARCHAR(50)  NOT NULL,  -- Ma | Mb | Ba1~Ba12 | U1~U3 ...
    circuit_name     VARCHAR(150),
    display_seq      INTEGER,
    remark_desc      VARCHAR(500),
    created_at       TIMESTAMPTZ  DEFAULT NOW(),
    updated_at       TIMESTAMPTZ  DEFAULT NOW(),
    UNIQUE (model_id, circuit_code)
);

-- B5: fnd_device_model_param — 迴路的參數定義（地址、scale、type）
CREATE TABLE fnd_device_model_param (
    param_id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    circuit_id            BIGINT NOT NULL REFERENCES fnd_device_model_circuit(circuit_id) ON DELETE CASCADE,
    electric_parameter_id BIGINT NOT NULL REFERENCES fnd_electric_parameter(electric_parameter_id),
    low_word_address      INTEGER NOT NULL,   -- APEX Low Word Address 慣例
    data_type             VARCHAR(16) NOT NULL,  -- uint16 | int16 | uint32 | int32 | float32
    decimal_place         INTEGER DEFAULT 0 NOT NULL,
    function_code         INTEGER DEFAULT 3 NOT NULL,
    remark_desc           VARCHAR(500),
    created_at            TIMESTAMPTZ  DEFAULT NOW(),
    updated_at            TIMESTAMPTZ  DEFAULT NOW(),
    UNIQUE (circuit_id, electric_parameter_id)
);

-- B6: fnd_ecsu — 用電計費單位（自我參照任意層級）
CREATE TABLE fnd_ecsu (
    ecsu_id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ecsu_code       VARCHAR(100) UNIQUE NOT NULL,
    ecsu_name       VARCHAR(150) NOT NULL,
    parent_id       BIGINT REFERENCES fnd_ecsu(ecsu_id),  -- 任意層級
    display_seq     INTEGER,
    enabled         BOOLEAN DEFAULT TRUE NOT NULL,
    remark_desc     VARCHAR(500),
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ix_ecsu_parent ON fnd_ecsu(parent_id) WHERE parent_id IS NOT NULL;

-- B6.1: fnd_ecsu_circuit_assgn — ECSU ↔ Device Circuit 綁定
CREATE TABLE fnd_ecsu_circuit_assgn (
    assgn_id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ecsu_id             BIGINT  NOT NULL REFERENCES fnd_ecsu(ecsu_id) ON DELETE CASCADE,
    device_id           VARCHAR(64) NOT NULL REFERENCES ems_device(device_id) ON DELETE CASCADE,
    circuit_code        VARCHAR(50) NOT NULL,   -- 對應 fnd_device_model_circuit.circuit_code
    sign                SMALLINT DEFAULT 1 NOT NULL,  -- +1 用電、-1 發電
    enabled             BOOLEAN DEFAULT TRUE NOT NULL,
    remark_desc         VARCHAR(500),
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (ecsu_id, device_id, circuit_code),
    CONSTRAINT chk_assgn_sign CHECK (sign IN (-1, 1))
);

-- B7: fnd_billing_rule — 三種計費規則合一（time_of_use / tier / period_map）
CREATE TABLE fnd_billing_rule (
    rule_id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    rule_kind        VARCHAR(32) NOT NULL,   -- time_of_use | tier | period_map
    rule_code        VARCHAR(50) NOT NULL,
    rule_name        VARCHAR(150),
    effective_from   DATE,
    effective_to     DATE,
    rule_json        JSONB NOT NULL,          -- 結構依 rule_kind 決定
    display_seq      INTEGER,
    enabled          BOOLEAN DEFAULT TRUE NOT NULL,
    remark_desc      VARCHAR(500),
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT chk_rule_kind CHECK (rule_kind IN ('time_of_use','tier','period_map')),
    UNIQUE (rule_kind, rule_code)
);

-- =============================================================================
-- LAYER C — 時序表（trx_*）1 張實體 + Continuous Aggregates
-- =============================================================================

-- C1: trx_reading — 展平後的時序 SSOT（hypertable）
-- 所有電力量測（來自 inbox modbus payload）統一展平成一 row/參數
CREATE TABLE trx_reading (
    ts                    TIMESTAMPTZ NOT NULL,
    device_id             VARCHAR(64) NOT NULL,
    circuit_code          VARCHAR(50) NOT NULL,   -- Ma / Mb / Ba1 / _all (thermal)
    parameter_code        VARCHAR(50) NOT NULL,   -- voltage / active_power / energy / max_temp ...
    value                 DOUBLE PRECISION NOT NULL,
    quality               SMALLINT DEFAULT 0 NOT NULL   -- 0=ok, 1=stale, 2=estimated, 3=bad
);

SELECT create_hypertable('trx_reading', 'ts',
    chunk_time_interval => INTERVAL '1 day');

CREATE INDEX ix_reading_device_param_ts ON trx_reading(device_id, parameter_code, ts DESC);
CREATE INDEX ix_reading_circuit_ts ON trx_reading(device_id, circuit_code, ts DESC);

-- Compression policy（30 天後壓縮，TimescaleDB 節省空間）
ALTER TABLE trx_reading SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'device_id, circuit_code, parameter_code',
    timescaledb.compress_orderby = 'ts DESC'
);
SELECT add_compression_policy('trx_reading', INTERVAL '30 days');

-- =============================================================================
-- CONTINUOUS AGGREGATES（從 trx_reading 自動匯聚）
-- =============================================================================

-- CA1: 15 分鐘 bucket（季度電量用）
CREATE MATERIALIZED VIEW cagg_reading_15min
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('15 minutes', ts) AS bucket_15m,
    device_id,
    circuit_code,
    parameter_code,
    AVG(value)   AS avg_value,
    MIN(value)   AS min_value,
    MAX(value)   AS max_value,
    FIRST(value, ts) AS first_value,
    LAST(value, ts)  AS last_value,
    COUNT(*)     AS sample_count
FROM trx_reading
GROUP BY bucket_15m, device_id, circuit_code, parameter_code
WITH NO DATA;

SELECT add_continuous_aggregate_policy('cagg_reading_15min',
    start_offset => INTERVAL '3 hours',
    end_offset   => INTERVAL '15 minutes',
    schedule_interval => INTERVAL '15 minutes');

-- CA2: 日 bucket
CREATE MATERIALIZED VIEW cagg_reading_daily
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 day', ts) AS bucket_day,
    device_id,
    circuit_code,
    parameter_code,
    AVG(value) AS avg_value,
    MIN(value) AS min_value,
    MAX(value) AS max_value,
    FIRST(value, ts) AS first_value,
    LAST(value, ts)  AS last_value,
    COUNT(*)  AS sample_count
FROM trx_reading
GROUP BY bucket_day, device_id, circuit_code, parameter_code
WITH NO DATA;

SELECT add_continuous_aggregate_policy('cagg_reading_daily',
    start_offset => INTERVAL '3 days',
    end_offset   => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour');

-- CA3: 月 bucket
CREATE MATERIALIZED VIEW cagg_reading_monthly
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 month', ts) AS bucket_month,
    device_id,
    circuit_code,
    parameter_code,
    AVG(value) AS avg_value,
    MIN(value) AS min_value,
    MAX(value) AS max_value,
    FIRST(value, ts) AS first_value,
    LAST(value, ts)  AS last_value,
    COUNT(*)  AS sample_count
FROM trx_reading
GROUP BY bucket_month, device_id, circuit_code, parameter_code
WITH NO DATA;

SELECT add_continuous_aggregate_policy('cagg_reading_monthly',
    start_offset => INTERVAL '3 months',
    end_offset   => INTERVAL '1 day',
    schedule_interval => INTERVAL '1 day');

-- CA4: 通訊成功率日統計（從 ems_events comm_abn kind 匯聚）
CREATE MATERIALIZED VIEW cagg_comm_success_daily
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 day', ts) AS bucket_day,
    edge_id,
    device_id,
    COUNT(*) FILTER (WHERE severity IN ('error','critical')) AS error_count,
    COUNT(*) AS total_events
FROM ems_events
WHERE event_kind = 'comm_abn'
GROUP BY bucket_day, edge_id, device_id
WITH NO DATA;

SELECT add_continuous_aggregate_policy('cagg_comm_success_daily',
    start_offset => INTERVAL '7 days',
    end_offset   => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour');

-- CA5: 熱像日統計（從 trx_reading thermal 參數匯聚）
CREATE MATERIALIZED VIEW cagg_thermal_daily
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 day', ts) AS bucket_day,
    device_id,
    parameter_code,
    MAX(value) AS daily_max,
    MIN(value) AS daily_min,
    AVG(value) AS daily_avg,
    COUNT(*)   AS sample_count
FROM trx_reading
WHERE parameter_code IN ('max_temp','min_temp','avg_temp')
GROUP BY bucket_day, device_id, parameter_code
WITH NO DATA;

SELECT add_continuous_aggregate_policy('cagg_thermal_daily',
    start_offset => INTERVAL '7 days',
    end_offset   => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour');

-- =============================================================================
-- RETENTION POLICIES
-- =============================================================================

-- inbox 保留 1 小時（冪等視窗），超過清掉
-- 用 TimescaleDB 不適合（inbox 不是 hypertable）→ 改為 cron job
-- 在部署層用 pg_cron 或 worker 定期 DELETE 即可。這裡先記註釋。
-- EXAMPLE:
--   DELETE FROM ems_ingest_inbox WHERE received_at < NOW() - INTERVAL '1 hour' AND processed_at IS NOT NULL;

-- trx_reading 保留 2 年後丟棄（已有 CA 彙總，原始資料可 drop）
SELECT add_retention_policy('trx_reading', INTERVAL '2 years');

-- ems_edge_heartbeat 保留 90 天
SELECT add_retention_policy('ems_edge_heartbeat', INTERVAL '90 days');

-- ems_events 保留 1 年
SELECT add_retention_policy('ems_events', INTERVAL '1 year');

-- =============================================================================
-- SEED DATA — 必要字典
-- =============================================================================

-- 電力參數字典（ADR-024 掃描後也會用到）
INSERT INTO fnd_electric_parameter (parameter_code, parameter_name, uom_name, data_type, decimal_place, parameter_category, display_seq) VALUES
    ('frequency',                '頻率',              'Hz',  'uint16',   2, 'frequency', 10),
    ('voltage',                  '電壓',              'V',   'uint32',   1, 'voltage',   20),
    ('avg_electric_current',     '電流',              'A',   'uint32',   3, 'current',   30),
    ('active_power',             '有效功率',          'W',   'int32',    0, 'power',     40),
    ('power_factor',             '功率因數',          'PF',  'int16',    1, 'power',     50),
    ('tot_input_active_energy',  '輸入總有效電能',    'kWh', 'uint32',   1, 'energy',    60),
    ('thd',                      '電流總諧波失真率',  '%',   'uint16',   1, 'thd',       70),
    ('active_power_demand',      '有效功率需量',      'W',   'int32',    0, 'demand',    80),
    ('max_temp',                 '最高溫度',          '°C',  'float32',  2, 'thermal',   100),
    ('min_temp',                 '最低溫度',          '°C',  'float32',  2, 'thermal',   101),
    ('avg_temp',                 '平均溫度',          '°C',  'float32',  2, 'thermal',   102);

COMMIT;

-- =============================================================================
-- END OF V2-final schema
-- =============================================================================
-- 表數量確認：
--   Layer A (ems_*) : 8 張（含 ems_device_thermal 骨架）
--   Layer B (fnd_*) : 8 張（含 fnd_ecsu_circuit_assgn）
--   Layer C (trx_*) : 1 張實體 + 5 個 CA
--   合計：17 張實體表 + 5 個 CA + 1 個 NOTIFY trigger
-- =============================================================================
