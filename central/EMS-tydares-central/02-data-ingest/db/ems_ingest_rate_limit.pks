-- Package Specification: ems_ingest_rate_limit
--
-- Purpose:
-- Implement atomic token bucket deduction for ingest throttling.
-- This package MUST enforce single-statement deduction semantics and MUST NOT perform any two-phase read-before-write logic.
--
-- All behavior implemented here is defined by Appendix A (Normative).

CREATE OR REPLACE PACKAGE ems_ingest_rate_limit AS
  -- Public Types
  TYPE t_rl_result IS RECORD (
    allowed         PLS_INTEGER,
    retry_after_sec NUMBER
  );

  -- Public Procedures / Functions
  FUNCTION try_consume_token(
    p_bucket_key IN VARCHAR2,
    p_cost       IN NUMBER DEFAULT ems_ingest_constants.RL_COST_PER_REQUEST
  ) RETURN t_rl_result;
END ems_ingest_rate_limit;
/
