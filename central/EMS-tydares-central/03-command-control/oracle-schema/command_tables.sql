-- EMS-tydares-central / 03-command-control
-- Command / Control / Action (CCA) tables
-- NOTE: Adjust tablespace, storage, and naming conventions per environment.

-- Command master table
CREATE TABLE ems_commands (
  command_id        VARCHAR2(128)   NOT NULL,
  device_id         VARCHAR2(64)    NOT NULL,
  command_type      VARCHAR2(128)   NOT NULL,
  payload_json      CLOB,
  status            VARCHAR2(32)    NOT NULL,
  priority          NUMBER          DEFAULT 50 NOT NULL,
  not_before_ts     TIMESTAMP(6),
  expire_ts         TIMESTAMP(6),
  idempotency_key   VARCHAR2(128),
  issued_by         VARCHAR2(128)   NOT NULL,
  created_at        TIMESTAMP(6)    DEFAULT SYSTIMESTAMP NOT NULL,
  updated_at        TIMESTAMP(6)    DEFAULT SYSTIMESTAMP NOT NULL,
  CONSTRAINT pk_ems_commands PRIMARY KEY (command_id),
  CONSTRAINT ck_ems_commands_status CHECK (status IN ('QUEUED', 'DELIVERED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELED')),
  CONSTRAINT fk_ems_commands_device FOREIGN KEY (device_id) REFERENCES ems_device(device_id)
);

-- Command events table (audit trail for all status transitions)
CREATE TABLE ems_command_events (
  event_id          NUMBER          GENERATED ALWAYS AS IDENTITY,
  command_id        VARCHAR2(128)   NOT NULL,
  ts                TIMESTAMP(6)    DEFAULT SYSTIMESTAMP NOT NULL,
  from_status       VARCHAR2(32),
  to_status         VARCHAR2(32)    NOT NULL,
  message           VARCHAR2(2000),
  result_json       CLOB,
  CONSTRAINT pk_ems_command_events PRIMARY KEY (event_id),
  CONSTRAINT fk_ems_command_events_command FOREIGN KEY (command_id) REFERENCES ems_commands(command_id) ON DELETE CASCADE,
  CONSTRAINT ck_ems_command_events_to_status CHECK (to_status IN ('QUEUED', 'DELIVERED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELED'))
);

-- Unique constraint for idempotency (if provided)
-- Note: Oracle UNIQUE index/constraint allows multiple NULL values, so this works correctly
-- Only non-NULL idempotency_key values must be unique
CREATE UNIQUE INDEX uk_ems_commands_idempotency ON ems_commands(idempotency_key);
