BEGIN
  ORDS.define_module(
    p_module_name    => 'ingest',
    p_base_path      => '/ingest/',
    p_items_per_page => 0
  );

  -- POST /ingest/{device_id}
  -- This handler is a thin HTTP shell. All ingest semantics are implemented in DB packages and defined by:
  -- - Appendix A (Normative)
  -- - docs/platform/ingest_http_flow.md
  -- - docs/platform/ingest_implementation_checklist.md
  -- This handler MUST NOT implement business logic.

  ORDS.define_template(
    p_module_name => 'ingest',
    p_pattern     => ':device_id'
  );

  ORDS.define_handler(
    p_module_name => 'ingest',
    p_pattern     => ':device_id',
    p_method      => 'POST',
    p_source_type => ORDS.source_type_plsql,
    p_source      => q'[
  /*
  This ORDS handler is a thin HTTP shell.
  All ingest semantics are implemented in DB packages and defined by:

  - Appendix A (Normative)
  - docs/platform/ingest_http_flow.md
  - docs/platform/ingest_implementation_checklist.md

  This handler MUST NOT implement business logic.
  */

DECLARE
  v_device_id        VARCHAR2(128);
  v_payload          CLOB;

  v_http_status      PLS_INTEGER;
  v_retry_after_sec  NUMBER;
  v_response_body    CLOB;
BEGIN
  -- 1) Extract path parameter
  v_device_id := :device_id;

  -- 2) Read request body as-is
  v_payload := :body;

  -- 3) Delegate ALL logic to DB entrypoint
  ems_ingest_entrypoint.handle_ingest(
    p_bucket_key        => v_device_id,
    p_payload           => v_payload,
    o_http_status       => v_http_status,
    o_retry_after_sec   => v_retry_after_sec,
    o_response_body     => v_response_body
  );

  -- 4) Set HTTP status
  ORDS.set_status(v_http_status);

  -- 5) Set headers (Retry-After in seconds when applicable)
  owa_util.mime_header('application/json', FALSE);
  IF v_retry_after_sec IS NOT NULL THEN
    owa_util.mime_header(
      name         => 'Retry-After',
      value        => TO_CHAR(CEIL(v_retry_after_sec)),
      close_header => FALSE
    );
  END IF;

  -- 6) Finalize headers
  owa_util.http_header_close;

  -- 7) Write response body
  htp.prn(v_response_body);
EXCEPTION
  WHEN OTHERS THEN
    -- Last-resort protection: unexpected failure
    ORDS.set_status(500);
    owa_util.mime_header('application/json', FALSE);
    owa_util.http_header_close;
    htp.prn('{"status":"error","message":"internal_error"}');
END;
]'
  );
END;
/
