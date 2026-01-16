-- Package Specification: ems_ingest_overload
--
-- Purpose:
-- Evaluate global ingest overload state and provide retry-after for short-circuit responses (HTTP 503).
-- This package MUST NOT change system state. It only computes overload signals based on inbox backlog and recent processing rate.
--
-- All behavior implemented here is defined by Appendix A (Normative).

CREATE OR REPLACE PACKAGE ems_ingest_overload AS
  -- Public Types
  TYPE t_overload_result IS RECORD (
    is_overloaded   PLS_INTEGER,
    retry_after_sec NUMBER,
    backlog_count   NUMBER,
    done_per_min    NUMBER,
    lag_min         NUMBER
  );

  -- Public Functions
  FUNCTION check_overload RETURN t_overload_result;
END ems_ingest_overload;
/
