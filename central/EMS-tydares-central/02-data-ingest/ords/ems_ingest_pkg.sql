-- EMS-tydares-central / 02-data-ingest
-- ORDS ingest package (deployable)
-- Contract: stored | duplicate | rejected

CREATE OR REPLACE PACKAGE ems_ingest_pkg AS
  PROCEDURE ingest_data (
    p_site_id           IN VARCHAR2,
    p_edge_id           IN VARCHAR2,
    p_idempotency_key   IN VARCHAR2,
    p_payload_json      IN CLOB,
    o_status            OUT VARCHAR2,
    o_http_code         OUT NUMBER,
    o_message           OUT VARCHAR2
  );

  PROCEDURE ingest_media (
    p_site_id           IN VARCHAR2,
    p_edge_id           IN VARCHAR2,
    p_idempotency_key   IN VARCHAR2,
    p_stored_path       IN VARCHAR2,
    p_sha256            IN VARCHAR2,
    o_status            OUT VARCHAR2,
    o_http_code         OUT NUMBER,
    o_message           OUT VARCHAR2
  );
END ems_ingest_pkg;
/

CREATE OR REPLACE PACKAGE BODY ems_ingest_pkg AS

  PROCEDURE ingest_data (
    p_site_id           IN VARCHAR2,
    p_edge_id           IN VARCHAR2,
    p_idempotency_key   IN VARCHAR2,
    p_payload_json      IN CLOB,
    o_status            OUT VARCHAR2,
    o_http_code         OUT NUMBER,
    o_message           OUT VARCHAR2
  ) IS
    v_ts_str    VARCHAR2(128);
    v_type      VARCHAR2(64);
    v_device_id VARCHAR2(64);
    v_msg_ts    TIMESTAMP(6) WITH TIME ZONE;
  BEGIN
    -- Required headers
    IF p_site_id IS NULL OR p_edge_id IS NULL OR p_idempotency_key IS NULL THEN
      o_status    := 'rejected';
      o_http_code := 400;
      o_message   := 'missing required header';
      RETURN;
    END IF;

    -- Validate JSON + required fields
    BEGIN
      SELECT
        json_value(p_payload_json, '$.ts' RETURNING VARCHAR2(128)),
        json_value(p_payload_json, '$.type' RETURNING VARCHAR2(64)),
        json_value(p_payload_json, '$.device_id' RETURNING VARCHAR2(64))
      INTO v_ts_str, v_type, v_device_id
      FROM dual;
    EXCEPTION
      WHEN OTHERS THEN
        o_status    := 'rejected';
        o_http_code := 400;
        o_message   := 'invalid json';
        RETURN;
    END;

    IF v_ts_str IS NULL THEN
      o_status    := 'rejected';
      o_http_code := 400;
      o_message   := 'missing field: ts';
      RETURN;
    END IF;

    IF v_type IS NULL THEN
      o_status    := 'rejected';
      o_http_code := 400;
      o_message   := 'missing field: type';
      RETURN;
    END IF;

    IF v_device_id IS NULL THEN
      o_status    := 'rejected';
      o_http_code := 400;
      o_message   := 'missing field: device_id';
      RETURN;
    END IF;

    BEGIN
      v_msg_ts := TO_TIMESTAMP_TZ(v_ts_str, 'YYYY-MM-DD"T"HH24:MI:SS.FF TZH:TZM');
    EXCEPTION
      WHEN OTHERS THEN
        BEGIN
          v_msg_ts := TO_TIMESTAMP_TZ(v_ts_str, 'YYYY-MM-DD"T"HH24:MI:SS TZH:TZM');
        EXCEPTION
          WHEN OTHERS THEN
            o_status    := 'rejected';
            o_http_code := 400;
            o_message   := 'invalid field: ts';
            RETURN;
        END;
    END;

    -- Idempotent insert
    BEGIN
      INSERT INTO ems_ingest_inbox (
        idemp_key, site_id, edge_id, device_id, msg_ts, msg_type, received_at, payload_json
      ) VALUES (
        p_idempotency_key, p_site_id, p_edge_id, v_device_id, v_msg_ts, v_type, SYSTIMESTAMP, p_payload_json
      );

      o_status    := 'stored';
      o_http_code := 200;
      o_message   := 'stored';
    EXCEPTION
      WHEN DUP_VAL_ON_INDEX THEN
        o_status    := 'duplicate';
        o_http_code := 200;
        o_message   := 'duplicate payload';
    END;
  EXCEPTION
    WHEN OTHERS THEN
      o_status    := 'rejected';
      o_http_code := 500;
      o_message   := SQLERRM;
  END ingest_data;

  PROCEDURE ingest_media (
    p_site_id           IN VARCHAR2,
    p_edge_id           IN VARCHAR2,
    p_idempotency_key   IN VARCHAR2,
    p_stored_path       IN VARCHAR2,
    p_sha256            IN VARCHAR2,
    o_status            OUT VARCHAR2,
    o_http_code         OUT NUMBER,
    o_message           OUT VARCHAR2
  ) IS
  BEGIN
    IF p_site_id IS NULL OR p_edge_id IS NULL OR p_idempotency_key IS NULL THEN
      o_status    := 'rejected';
      o_http_code := 400;
      o_message   := 'missing required header';
      RETURN;
    END IF;

    BEGIN
      INSERT INTO ems_media_inbox (
        idemp_key, site_id, edge_id, received_at, stored_path, sha256
      ) VALUES (
        p_idempotency_key, p_site_id, p_edge_id, SYSTIMESTAMP, p_stored_path, p_sha256
      );

      o_status    := 'stored';
      o_http_code := 200;
      o_message   := 'stored';
    EXCEPTION
      WHEN DUP_VAL_ON_INDEX THEN
        o_status    := 'duplicate';
        o_http_code := 200;
        o_message   := 'duplicate media';
    END;
  EXCEPTION
    WHEN OTHERS THEN
      o_status    := 'rejected';
      o_http_code := 500;
      o_message   := SQLERRM;
  END ingest_media;

END ems_ingest_pkg;
/
