-- EMS-tydares-central / 01-core-platform
-- Core indexes

CREATE INDEX ix_ems_edge_site ON ems_edge(site_id);
CREATE INDEX ix_ems_device_edge ON ems_device(edge_id);
CREATE INDEX ix_ems_edge_hb_ts ON ems_edge_heartbeat(hb_ts);
