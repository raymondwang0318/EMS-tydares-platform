BEGIN
  ORDS.define_template(
    p_module_name => 'ingest',
    p_pattern     => 'media'
  );

  ORDS.define_handler(
    p_module_name => 'ingest',
    p_pattern     => 'media',
    p_method      => 'POST',
    p_source_type => ORDS.source_type_plsql,
    p_source      => q'[
DECLARE
  v_site_id  VARCHAR2(64);
  v_edge_id  VARCHAR2(64);
  v_idemp    VARCHAR2(128);
  v_status   VARCHAR2(20);
  v_http     NUMBER;
  v_message  VARCHAR2(4000);
  v_err_code VARCHAR2(64);

  FUNCTION get_hdr(p_name IN VARCHAR2) RETURN VARCHAR2 IS
  BEGIN
    RETURN owa_util.get_cgi_env(p_name);
  END;
BEGIN
  v_site_id := get_hdr('HTTP_X_SITE_ID');
  v_edge_id := get_hdr('HTTP_X_EDGE_ID');
  v_idemp   := get_hdr('HTTP_X_IDEMPOTENCY_KEY');

  ems_ingest_pkg.ingest_media(
    p_site_id         => v_site_id,
    p_edge_id         => v_edge_id,
    p_idempotency_key => v_idemp,
    p_stored_path     => :stored_path,
    p_sha256          => :sha256,
    o_status          => v_status,
    o_http_code       => v_http,
    o_message         => v_message
  );

  IF v_http = 400 THEN
    v_err_code := 'BAD_REQUEST';
  ELSIF v_http = 413 THEN
    v_err_code := 'PAYLOAD_TOO_LARGE';
  ELSIF v_http = 429 THEN
    v_err_code := 'RATE_LIMIT';
  ELSIF v_http = 503 THEN
    v_err_code := 'SERVICE_UNAVAILABLE';
  ELSIF v_http = 500 THEN
    v_err_code := 'SERVER_ERROR';
  ELSE
    v_err_code := NULL;
  END IF;

  ORDS.set_status(v_http);
  owa_util.mime_header('application/json', FALSE);
  owa_util.http_header_close;

  IF v_http = 200 THEN
    htp.p(
      json_object(
        'ok' VALUE TRUE,
        'status' VALUE v_status,
        'idempotency_key' VALUE v_idemp,
        'server_time' VALUE TO_CHAR(SYSTIMESTAMP, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM')
        RETURNING CLOB
      )
    );
  ELSE
    htp.p(
      json_object(
        'ok' VALUE FALSE,
        'status' VALUE 'rejected',
        'error_code' VALUE v_err_code,
        'message' VALUE v_message,
        'idempotency_key' VALUE v_idemp,
        'server_time' VALUE TO_CHAR(SYSTIMESTAMP, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM')
        RETURNING CLOB
      )
    );
  END IF;
END;
]'
  );
END;
/
