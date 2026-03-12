-- EMS-tydares-central / 03-command-control
-- Command tables indexes

-- Index for polling queries (device_id + status + not_before_ts + expire_ts)
CREATE INDEX ix_ems_commands_poll ON ems_commands(device_id, status, not_before_ts, expire_ts);

-- Index for status queries
CREATE INDEX ix_ems_commands_status ON ems_commands(status, created_at);

-- Index for device queries
CREATE INDEX ix_ems_commands_device ON ems_commands(device_id, status, created_at);

-- Index for command events by command_id (for audit trail queries)
CREATE INDEX ix_ems_command_events_command ON ems_command_events(command_id, ts);

-- Index for command events by timestamp (for time-based queries)
CREATE INDEX ix_ems_command_events_ts ON ems_command_events(ts);
