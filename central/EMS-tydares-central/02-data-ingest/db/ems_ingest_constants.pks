-- Package Specification: ems_ingest_constants
--
-- Purpose:
-- Centralize all numeric and enumerated constants used by ingest throttling.
-- This package MUST NOT read tables, MUST NOT have side effects, and MUST remain stable once Appendix A is finalized.
--
-- All values defined here represent semantic boundaries defined by Appendix A (Normative).

CREATE OR REPLACE PACKAGE ems_ingest_constants AS
  -- ACK phase
  ACK_HTTP_PHASE_200       CONSTANT PLS_INTEGER := 1;
  ACK_HTTP_PHASE_202       CONSTANT PLS_INTEGER := 2;

  -- Retry-After bounds (seconds)
  RETRY_AFTER_MIN_SEC      CONSTANT PLS_INTEGER := 1;
  RETRY_AFTER_MAX_SEC      CONSTANT PLS_INTEGER := 30;

  -- Rate limit (token bucket)
  RL_DEFAULT_CAPACITY      CONSTANT NUMBER := 100;
  RL_DEFAULT_REFILL_PER_SEC CONSTANT NUMBER := 10;
  RL_COST_PER_REQUEST      CONSTANT NUMBER := 1;

  -- Global overload thresholds
  OVERLOAD_BACKLOG_X       CONSTANT NUMBER := 1000;
  OVERLOAD_LAG_MIN_Y       CONSTANT NUMBER := 5;
  OVERLOAD_RATE_WINDOW_MIN CONSTANT NUMBER := 1;

  -- Worker retry/backoff
  WORKER_ATTEMPTS_MAX      CONSTANT PLS_INTEGER := 10;
  WORKER_BACKOFF_CAP_SEC   CONSTANT PLS_INTEGER := 300;
  WORKER_JITTER_MAX        CONSTANT NUMBER := 0.3;
END ems_ingest_constants;
/
