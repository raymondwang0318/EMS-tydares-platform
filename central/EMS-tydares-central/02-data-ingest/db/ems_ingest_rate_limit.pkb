-- Package Body: ems_ingest_rate_limit

CREATE OR REPLACE PACKAGE BODY ems_ingest_rate_limit AS

  FUNCTION try_consume_token(
    p_bucket_key IN VARCHAR2,
    p_cost       IN NUMBER
  ) RETURN t_rl_result
  IS
    v_now_utc        DATE;
    v_capacity       NUMBER;
    v_refill_per_sec NUMBER;
    v_tokens_before  NUMBER;
    v_tokens_after   NUMBER;
    v_last_refill_utc DATE;
    v_retry_after    NUMBER;
    v_bounds         SYS.ODCINUMBERLIST;
    v_result         t_rl_result;
  BEGIN
    -- Statement-level time consistency
    v_now_utc := CAST(SYS_EXTRACT_UTC(SYSTIMESTAMP) AS DATE);

    -- Read retry-after bounds once
    v_bounds := ems_ingest_settings.get_retry_after_bounds;

    /*
    Atomic token deduction:
    - Refill uses whole-second granularity (FLOOR) by design.
    - Deduction and state update occur in a single UPDATE statement.
    - No SELECT-before-UPDATE is allowed.

    Table contract (assumed by this package; must exist in DB):
    - ems_rate_limit_bucket(bucket_key PK, tokens, capacity, refill_per_sec, last_refill_utc)
    */
    UPDATE ems_rate_limit_bucket b
       SET
         -- compute new token count with refill
         tokens = LEAST(
           b.capacity,
           b.tokens
           + FLOOR((v_now_utc - b.last_refill_utc) * 86400)
           * b.refill_per_sec
         )
         - p_cost,
         last_refill_utc = v_now_utc
     WHERE
       b.bucket_key = p_bucket_key
       AND
       (
         LEAST(
           b.capacity,
           b.tokens
           + FLOOR((v_now_utc - b.last_refill_utc) * 86400)
           * b.refill_per_sec
         )
         >= p_cost
       )
    RETURNING
      b.tokens + p_cost,
      b.tokens,
      b.capacity,
      b.refill_per_sec
    INTO
      v_tokens_before,
      v_tokens_after,
      v_capacity,
      v_refill_per_sec;

    IF SQL%ROWCOUNT = 1 THEN
      -- Allowed: token successfully consumed
      v_result.allowed := 1;
      v_result.retry_after_sec := NULL;
      RETURN v_result;
    END IF;

    /*
    Not allowed:
    Token was insufficient at statement execution time.
    This SELECT is for retry-after estimation only and does NOT affect consistency.
    It may read a slightly stale last_refill_utc; this is acceptable by design.
    */
    SELECT
      b.tokens,
      b.capacity,
      b.refill_per_sec,
      b.last_refill_utc
    INTO
      v_tokens_before,
      v_capacity,
      v_refill_per_sec,
      v_last_refill_utc
    FROM ems_rate_limit_bucket b
    WHERE b.bucket_key = p_bucket_key;

    IF v_refill_per_sec <= 0 THEN
      v_retry_after := v_bounds(2); -- max cap
    ELSE
      v_retry_after :=
        CEIL(
          (p_cost - v_tokens_before)
          / v_refill_per_sec
        );
    END IF;

    -- Enforce bounds
    IF v_retry_after < v_bounds(1) THEN
      v_retry_after := v_bounds(1);
    ELSIF v_retry_after > v_bounds(2) THEN
      v_retry_after := v_bounds(2);
    END IF;

    v_result.allowed := 0;
    v_result.retry_after_sec := v_retry_after;
    RETURN v_result;

  EXCEPTION
    WHEN NO_DATA_FOUND THEN
      -- Missing bucket is treated as throttled with max retry-after
      v_result.allowed := 0;
      v_result.retry_after_sec := v_bounds(2);
      RETURN v_result;
  END try_consume_token;

END ems_ingest_rate_limit;
/
