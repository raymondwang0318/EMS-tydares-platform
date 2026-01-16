-- Package Body: ems_ingest_overload

CREATE OR REPLACE PACKAGE BODY ems_ingest_overload AS

  FUNCTION check_overload RETURN t_overload_result
  IS
    v_cfg    ems_ingest_settings.t_overload_thresholds;
    v_bounds SYS.ODCINUMBERLIST;

    v_backlog      NUMBER;
    v_done         NUMBER;
    v_done_per_min NUMBER;
    v_lag_min      NUMBER;

    v_retry_after  NUMBER;
    v_res          t_overload_result;
  BEGIN
    v_cfg := ems_ingest_settings.get_overload_thresholds;
    v_bounds := ems_ingest_settings.get_retry_after_bounds;

    /*
    Compute backlog:
    - Count messages pending processing (Appendix A.2 uses NEW backlog).
    - This is a read-only estimation used for short-circuit decisions.
    */
    SELECT COUNT(*)
      INTO v_backlog
      FROM ems_ingest_inbox i
     WHERE i.process_status = 'NEW'
       AND (i.next_attempt_at IS NULL OR i.next_attempt_at <= SYSTIMESTAMP);

    /*
    Compute done_per_min:
    - Count processed messages in the last N minutes, then normalize to per-minute.
    - Window size comes from settings/constants (Appendix A.2).
    */
    SELECT COUNT(*)
      INTO v_done
      FROM ems_ingest_inbox i
     WHERE i.process_status = 'DONE'
       AND i.processed_at >= SYSTIMESTAMP - NUMTODSINTERVAL(v_cfg.rate_window_min, 'MINUTE');

    IF v_cfg.rate_window_min <= 0 THEN
      v_done_per_min := 0;
    ELSE
      v_done_per_min := CEIL(v_done / v_cfg.rate_window_min);
    END IF;

    /*
    Compute lag_min:
    - A conservative estimate: backlog divided by done_per_min.
    - If done_per_min is 0, lag is treated as very large.
    */
    IF v_done_per_min <= 0 THEN
      v_lag_min := 999999;
    ELSE
      v_lag_min := CEIL(v_backlog / v_done_per_min);
    END IF;

    /*
    Overload decision (trigger thresholds):
    - Trigger if backlog exceeds X OR lag exceeds Y minutes.
    - Use hysteresis thresholds X_off / Y_off for unlock logic (Appendix A.2).
    - This function only reports current overload signal; persistence is handled by caller.
    */
    IF (v_backlog > v_cfg.backlog_x) OR (v_lag_min > v_cfg.lag_min_y) THEN
      v_res.is_overloaded := 1;
    ELSIF (v_backlog < v_cfg.backlog_x_off) AND (v_lag_min < v_cfg.lag_min_y_off) THEN
      v_res.is_overloaded := 0;
    ELSE
      -- In hysteresis band: treat as overloaded (conservative short-circuit)
      v_res.is_overloaded := 1;
    END IF;

    /*
    retry-after:
    - If overloaded, derive retry-after from lag, bounded by min/max.
    - If done_per_min is 0, return max cap.
    - Unit: seconds (HTTP Retry-After header).
    */
    IF v_res.is_overloaded = 1 THEN
      IF v_done_per_min <= 0 THEN
        v_retry_after := v_bounds(2);
      ELSE
        v_retry_after := v_lag_min * 60; -- convert minutes to seconds (Appendix A.2 uses backlog/rate -> seconds)
      END IF;

      IF v_retry_after < v_bounds(1) THEN
        v_retry_after := v_bounds(1);
      ELSIF v_retry_after > v_bounds(2) THEN
        v_retry_after := v_bounds(2);
      END IF;

      v_res.retry_after_sec := v_retry_after;
    ELSE
      v_res.retry_after_sec := NULL;
    END IF;

    v_res.backlog_count := v_backlog;
    v_res.done_per_min := v_done_per_min;
    v_res.lag_min := v_lag_min;

    RETURN v_res;
  END check_overload;

END ems_ingest_overload;
/
