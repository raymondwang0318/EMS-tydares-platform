-- Package Specification: ems_ingest_entrypoint
--
-- Purpose:
-- HTTP ingress glue procedure for ingest requests.
-- This package MUST conform to docs/platform/ingest_http_flow.md and Appendix A.

CREATE OR REPLACE PACKAGE ems_ingest_entrypoint AS
  -- Public Procedures
  PROCEDURE handle_ingest(
    p_bucket_key        IN VARCHAR2,
    p_payload           IN CLOB,
    o_http_status       OUT PLS_INTEGER,
    o_retry_after_sec   OUT NUMBER,
    o_response_body     OUT CLOB
  );
END ems_ingest_entrypoint;
/
