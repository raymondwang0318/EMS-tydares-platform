-- EMS-tydares-central / 01-core-platform
-- Core tables (IDs, dictionaries, heartbeat)
-- NOTE: Adjust tablespace, storage, and naming conventions per environment.

-- System identity: sites, edges, devices
CREATE TABLE ems_site (
  site_id        VARCHAR2(64)    NOT NULL,
  site_name      VARCHAR2(200)   NOT NULL,
  created_at     TIMESTAMP(6)    DEFAULT SYSTIMESTAMP NOT NULL,
  CONSTRAINT pk_ems_site PRIMARY KEY (site_id)
);

CREATE TABLE ems_edge (
  edge_id        VARCHAR2(64)    NOT NULL,
  site_id        VARCHAR2(64)    NOT NULL,
  edge_name      VARCHAR2(200),
  created_at     TIMESTAMP(6)    DEFAULT SYSTIMESTAMP NOT NULL,
  CONSTRAINT pk_ems_edge PRIMARY KEY (edge_id),
  CONSTRAINT fk_ems_edge_site FOREIGN KEY (site_id) REFERENCES ems_site(site_id)
);

CREATE TABLE ems_device (
  device_id      VARCHAR2(64)    NOT NULL,
  edge_id        VARCHAR2(64)    NOT NULL,
  device_type    VARCHAR2(64)    NOT NULL,
  device_name    VARCHAR2(200),
  created_at     TIMESTAMP(6)    DEFAULT SYSTIMESTAMP NOT NULL,
  CONSTRAINT pk_ems_device PRIMARY KEY (device_id),
  CONSTRAINT fk_ems_device_edge FOREIGN KEY (edge_id) REFERENCES ems_edge(edge_id)
);

-- Dictionary tables (status codes, event types)
CREATE TABLE ems_dict_status (
  status_code    VARCHAR2(64)    NOT NULL,
  status_name    VARCHAR2(200)   NOT NULL,
  is_active      CHAR(1)         DEFAULT 'Y' NOT NULL,
  CONSTRAINT pk_ems_dict_status PRIMARY KEY (status_code)
);

CREATE TABLE ems_dict_event_type (
  event_type     VARCHAR2(64)    NOT NULL,
  event_name     VARCHAR2(200)   NOT NULL,
  is_active      CHAR(1)         DEFAULT 'Y' NOT NULL,
  CONSTRAINT pk_ems_dict_event_type PRIMARY KEY (event_type)
);

-- Heartbeat
CREATE TABLE ems_edge_heartbeat (
  edge_id        VARCHAR2(64)    NOT NULL,
  hb_ts          TIMESTAMP(6)    NOT NULL,
  ip_addr        VARCHAR2(64),
  payload_json   CLOB,
  CONSTRAINT pk_ems_edge_heartbeat PRIMARY KEY (edge_id, hb_ts),
  CONSTRAINT fk_ems_edge_heartbeat_edge FOREIGN KEY (edge_id) REFERENCES ems_edge(edge_id)
);
