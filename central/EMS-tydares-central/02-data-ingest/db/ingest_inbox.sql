-- EMS-tydares-central / 02-data-ingest
-- Ingest inbox tables (idempotency, ACK)

-- Incoming data messages from edge
CREATE TABLE ems_ingest_inbox (
  idemp_key        VARCHAR2(128)       NOT NULL,
  site_id          VARCHAR2(64)        NOT NULL,
  edge_id          VARCHAR2(64)        NOT NULL,
  device_id        VARCHAR2(64),
  msg_ts           TIMESTAMP(6) WITH TIME ZONE,
  msg_type         VARCHAR2(64),
  received_at      TIMESTAMP(6)        DEFAULT SYSTIMESTAMP NOT NULL,
  payload_json     CLOB                NOT NULL,
  payload_sha256   VARCHAR2(64),
  CONSTRAINT pk_ems_ingest_inbox PRIMARY KEY (idemp_key)
);

CREATE INDEX ix_ems_ingest_inbox_received ON ems_ingest_inbox(received_at);
CREATE INDEX ix_ems_ingest_inbox_site_edge_received ON ems_ingest_inbox(site_id, edge_id, received_at);
