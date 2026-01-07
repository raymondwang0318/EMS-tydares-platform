-- EMS-tydares-central / 02-data-ingest
-- Media inbox (metadata + idempotency). Actual blobs may live in object storage/filesystem.

CREATE TABLE ems_media_inbox (
  idemp_key      VARCHAR2(128)   NOT NULL,
  site_id        VARCHAR2(64)    NOT NULL,
  edge_id        VARCHAR2(64)    NOT NULL,
  device_id      VARCHAR2(64),
  received_at    TIMESTAMP(6)    DEFAULT SYSTIMESTAMP NOT NULL,
  media_type     VARCHAR2(32)    NOT NULL, -- image/video/thermal/other
  content_type   VARCHAR2(128),
  file_name      VARCHAR2(512),
  storage_uri    VARCHAR2(2000),
  stored_path    VARCHAR2(2000),
  sha256         VARCHAR2(64),
  meta_json      CLOB,
  CONSTRAINT pk_ems_media_inbox PRIMARY KEY (idemp_key)
);

CREATE INDEX ix_ems_media_inbox_received ON ems_media_inbox(received_at);
CREATE INDEX ix_ems_media_inbox_site_edge_received ON ems_media_inbox(site_id, edge_id, received_at);
