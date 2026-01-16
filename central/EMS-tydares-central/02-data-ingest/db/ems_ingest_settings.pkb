-- Package Body: ems_ingest_settings
--
-- Purpose:
-- Provide safe accessors to configuration values with strict fallback behavior.
-- All values are validated defensively to prevent semantic drift from Appendix A.

CREATE OR REPLACE PACKAGE BODY ems_ingest_settings AS

  FUNCTION get_ack_http_phase RETURN PLS_INTEGER IS
    v_phase PLS_INTEGER;
  BEGIN
    SELECT ack_http_phase
      INTO v_phase
      FROM ems_ingest_config
     WHERE ROWNUM = 1;

    IF v_phase IN (
      ems_ingest_constants.ACK_HTTP_PHASE_200,
      ems_ingest_constants.ACK_HTTP_PHASE_202
    ) THEN
      RETURN v_phase;
    ELSE
      RETURN ems_ingest_constants.ACK_HTTP_PHASE_202;
    END IF;

  EXCEPTION
    WHEN NO_DATA_FOUND THEN
      RETURN ems_ingest_constants.ACK_HTTP_PHASE_202;
  END get_ack_http_phase;


  FUNCTION get_retry_after_bounds RETURN SYS.ODCINUMBERLIST IS
  BEGIN
    RETURN SYS.ODCINUMBERLIST(
      ems_ingest_constants.RETRY_AFTER_MIN_SEC,
      ems_ingest_constants.RETRY_AFTER_MAX_SEC
    );
  END get_retry_after_bounds;


  FUNCTION get_rate_limit_defaults RETURN SYS.ODCINUMBERLIST IS
  BEGIN
    RETURN SYS.ODCINUMBERLIST(
      ems_ingest_constants.RL_DEFAULT_CAPACITY,
      ems_ingest_constants.RL_DEFAULT_REFILL_PER_SEC,
      ems_ingest_constants.RL_COST_PER_REQUEST
    );
  END get_rate_limit_defaults;


  FUNCTION get_overload_thresholds RETURN t_overload_thresholds IS
    v_cfg t_overload_thresholds;
  BEGIN
    SELECT
      backlog_x,
      backlog_x_off,
      lag_min_y,
      lag_min_y_off,
      rate_window_min
    INTO
      v_cfg.backlog_x,
      v_cfg.backlog_x_off,
      v_cfg.lag_min_y,
      v_cfg.lag_min_y_off,
      v_cfg.rate_window_min
    FROM ems_ingest_config
    WHERE ROWNUM = 1;

    IF v_cfg.backlog_x_off IS NULL THEN
      v_cfg.backlog_x_off := FLOOR(v_cfg.backlog_x * 0.7);
    END IF;

    IF v_cfg.lag_min_y_off IS NULL THEN
      v_cfg.lag_min_y_off := FLOOR(v_cfg.lag_min_y * 0.7);
    END IF;

    RETURN v_cfg;

  EXCEPTION
    WHEN NO_DATA_FOUND THEN
      v_cfg.backlog_x := ems_ingest_constants.OVERLOAD_BACKLOG_X;
      v_cfg.backlog_x_off := FLOOR(ems_ingest_constants.OVERLOAD_BACKLOG_X * 0.7);
      v_cfg.lag_min_y := ems_ingest_constants.OVERLOAD_LAG_MIN_Y;
      v_cfg.lag_min_y_off := FLOOR(ems_ingest_constants.OVERLOAD_LAG_MIN_Y * 0.7);
      v_cfg.rate_window_min := ems_ingest_constants.OVERLOAD_RATE_WINDOW_MIN;
      RETURN v_cfg;
  END get_overload_thresholds;


  FUNCTION get_worker_backoff_limits RETURN SYS.ODCINUMBERLIST IS
  BEGIN
    RETURN SYS.ODCINUMBERLIST(
      ems_ingest_constants.WORKER_ATTEMPTS_MAX,
      ems_ingest_constants.WORKER_BACKOFF_CAP_SEC,
      ems_ingest_constants.WORKER_JITTER_MAX
    );
  END get_worker_backoff_limits;

END ems_ingest_settings;
/
