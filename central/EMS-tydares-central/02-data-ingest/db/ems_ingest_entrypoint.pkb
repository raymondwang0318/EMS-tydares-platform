-- Package Body: ems_ingest_entrypoint

CREATE OR REPLACE PACKAGE BODY ems_ingest_entrypoint AS

  PROCEDURE handle_ingest(
    p_bucket_key        IN VARCHAR2,
    p_payload           IN CLOB,
    o_http_status       OUT PLS_INTEGER,
    o_retry_after_sec   OUT NUMBER,
    o_response_body     OUT CLOB
  ) IS
    v_over ems_ingest_overload.t_overload_result;
    v_rl   ems_ingest_rate_limit.t_rl_result;
  BEGIN
    -- Step 1: Global overload short-circuit
    v_over := ems_ingest_overload.check_overload;

    IF v_over.is_overloaded = 1 THEN
      o_http_status := 503;
      o_retry_after_sec := v_over.retry_after_sec;
      o_response_body := '{"status":"rejected","reason":"overloaded"}';
      RETURN;
    END IF;

    -- Step 2: Per-device rate limit
    v_rl := ems_ingest_rate_limit.try_consume_token(p_bucket_key);

    IF v_rl.allowed = 0 THEN
      o_http_status := 429;
      o_retry_after_sec := v_rl.retry_after_sec;
      o_response_body := '{"status":"rejected","reason":"rate_limited"}';
      RETURN;
    END IF;

    -- Step 3: Inbox ingest (placeholder; actual implementation elsewhere)
    -- NOTE: To fully conform to Appendix A, ingress success body should be based on inbox result (stored|duplicate).
    -- ems_ingest_inbox.store(p_payload);

    -- Step 4: HTTP acknowledgement
    o_http_status := CASE ems_ingest_settings.get_ack_http_phase
      WHEN ems_ingest_constants.ACK_HTTP_PHASE_200 THEN 200
      ELSE 202
    END;

    o_retry_after_sec := NULL;
    o_response_body := '{"status":"accepted"}';
  END handle_ingest;

END ems_ingest_entrypoint;
/
