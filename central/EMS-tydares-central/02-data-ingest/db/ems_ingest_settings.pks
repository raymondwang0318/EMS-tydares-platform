-- Package Specification: ems_ingest_settings
--
-- Purpose:
-- Centralize all reads of runtime configuration for ingest throttling.
-- This package MAY read configuration tables but MUST NOT implement business logic.
-- All returned values MUST conform to Appendix A (Normative) and MUST fallback to ems_ingest_constants when configuration is missing or invalid.
--
-- Design Rules:
-- - No side effects
-- - No writes
-- - No timing or concurrency decisions
-- - Values returned here are inputs to logic defined elsewhere

CREATE OR REPLACE PACKAGE ems_ingest_settings AS
  -- Public Types
  TYPE t_overload_thresholds IS RECORD (
    backlog_x        NUMBER,
    backlog_x_off    NUMBER,
    lag_min_y        NUMBER,
    lag_min_y_off    NUMBER,
    rate_window_min  NUMBER
  );

  -- Public Functions
  FUNCTION get_ack_http_phase RETURN PLS_INTEGER;

  FUNCTION get_retry_after_bounds RETURN SYS.ODCINUMBERLIST;

  FUNCTION get_rate_limit_defaults RETURN SYS.ODCINUMBERLIST;

  FUNCTION get_overload_thresholds RETURN t_overload_thresholds;

  FUNCTION get_worker_backoff_limits RETURN SYS.ODCINUMBERLIST;
END ems_ingest_settings;
/
