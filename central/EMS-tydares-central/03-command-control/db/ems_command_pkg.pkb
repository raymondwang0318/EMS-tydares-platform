-- Package Body: ems_command_pkg

CREATE OR REPLACE PACKAGE BODY ems_command_pkg AS

  FUNCTION create_command(
    p_device_id         IN VARCHAR2,
    p_command_type      IN VARCHAR2,
    p_payload_json      IN CLOB,
    p_priority          IN NUMBER DEFAULT 50,
    p_not_before_ts     IN TIMESTAMP DEFAULT NULL,
    p_expire_ts         IN TIMESTAMP DEFAULT NULL,
    p_idempotency_key   IN VARCHAR2 DEFAULT NULL,
    p_issued_by         IN VARCHAR2
  ) RETURN VARCHAR2 IS
    v_command_id        VARCHAR2(128);
    v_current_ts        TIMESTAMP(6) := SYSTIMESTAMP;
  BEGIN
    -- Generate command_id (UUID-like format: use SYS_GUID() for Oracle)
    v_command_id := LOWER(RAWTOHEX(SYS_GUID()));

    -- Insert command with status QUEUED
    INSERT INTO ems_commands (
      command_id,
      device_id,
      command_type,
      payload_json,
      status,
      priority,
      not_before_ts,
      expire_ts,
      idempotency_key,
      issued_by,
      created_at,
      updated_at
    ) VALUES (
      v_command_id,
      p_device_id,
      p_command_type,
      p_payload_json,
      'QUEUED',
      p_priority,
      p_not_before_ts,
      p_expire_ts,
      p_idempotency_key,
      p_issued_by,
      v_current_ts,
      v_current_ts
    );

    -- Record event: NULL -> QUEUED
    INSERT INTO ems_command_events (
      command_id,
      ts,
      from_status,
      to_status,
      message
    ) VALUES (
      v_command_id,
      v_current_ts,
      NULL,
      'QUEUED',
      'Command created'
    );

    RETURN v_command_id;
  EXCEPTION
    WHEN DUP_VAL_ON_INDEX THEN
      -- Idempotency key conflict: return existing command_id
      SELECT command_id INTO v_command_id
      FROM ems_commands
      WHERE idempotency_key = p_idempotency_key
        AND idempotency_key IS NOT NULL;
      RETURN v_command_id;
  END create_command;

  FUNCTION poll_command(
    p_device_id         IN VARCHAR2,
    o_command_record    OUT t_command_record
  ) RETURN NUMBER IS
    v_current_ts        TIMESTAMP(6) := SYSTIMESTAMP;
    v_command_id        VARCHAR2(128);
    v_command_type      VARCHAR2(128);
    v_payload_json      CLOB;
    v_found             NUMBER := 0;
  BEGIN
    -- Atomic select + update using FOR UPDATE SKIP LOCKED
    -- This ensures only one poller can claim a command
    SELECT command_id, command_type, payload_json
    INTO v_command_id, v_command_type, v_payload_json
    FROM (
      SELECT command_id, command_type, payload_json, priority
      FROM ems_commands
      WHERE device_id = p_device_id
        AND status = 'QUEUED'
        AND (not_before_ts IS NULL OR not_before_ts <= v_current_ts)
        AND (expire_ts IS NULL OR expire_ts > v_current_ts)
      ORDER BY priority DESC, created_at ASC
      FETCH FIRST 1 ROW ONLY
    ) FOR UPDATE SKIP LOCKED;

    -- Update status to DELIVERED (atomic)
    UPDATE ems_commands
    SET status = 'DELIVERED',
        updated_at = v_current_ts
    WHERE command_id = v_command_id
      AND status = 'QUEUED'; -- Double-check to prevent race condition

    -- Record event: QUEUED -> DELIVERED
    INSERT INTO ems_command_events (
      command_id,
      ts,
      from_status,
      to_status,
      message
    ) VALUES (
      v_command_id,
      v_current_ts,
      'QUEUED',
      'DELIVERED',
      'Command delivered to edge'
    );

    -- Set output record
    o_command_record.command_id := v_command_id;
    o_command_record.command_type := v_command_type;
    o_command_record.payload_json := v_payload_json;

    v_found := 1;
    RETURN v_found;

  EXCEPTION
    WHEN NO_DATA_FOUND THEN
      RETURN 0;
    WHEN OTHERS THEN
      -- Re-raise exception
      RAISE;
  END poll_command;

  PROCEDURE complete_command(
    p_command_id        IN VARCHAR2,
    p_final_status      IN VARCHAR2,
    p_result_json       IN CLOB DEFAULT NULL,
    p_message           IN VARCHAR2 DEFAULT NULL
  ) IS
    v_current_ts        TIMESTAMP(6) := SYSTIMESTAMP;
    v_from_status       VARCHAR2(32);
  BEGIN
    -- Validate final_status
    IF p_final_status NOT IN ('SUCCEEDED', 'FAILED') THEN
      RAISE_APPLICATION_ERROR(-20001, 'Invalid final_status. Must be SUCCEEDED or FAILED.');
    END IF;

    -- Get current status and update atomically
    SELECT status INTO v_from_status
    FROM ems_commands
    WHERE command_id = p_command_id
    FOR UPDATE;

    -- Validate state transition (DELIVERED -> RUNNING -> final_status)
    -- Allow transition from DELIVERED or RUNNING to final_status
    IF v_from_status NOT IN ('DELIVERED', 'RUNNING') THEN
      RAISE_APPLICATION_ERROR(-20002, 
        'Invalid state transition. Current status: ' || v_from_status || 
        '. Can only complete from DELIVERED or RUNNING.');
    END IF;

    -- If current status is DELIVERED, first transition to RUNNING
    IF v_from_status = 'DELIVERED' THEN
      UPDATE ems_commands
      SET status = 'RUNNING',
          updated_at = v_current_ts
      WHERE command_id = p_command_id;

      -- Record event: DELIVERED -> RUNNING
      INSERT INTO ems_command_events (
        command_id,
        ts,
        from_status,
        to_status,
        message
      ) VALUES (
        p_command_id,
        v_current_ts,
        'DELIVERED',
        'RUNNING',
        'Command execution started'
      );

      v_from_status := 'RUNNING';
    END IF;

    -- Update to final status
    UPDATE ems_commands
    SET status = p_final_status,
        updated_at = v_current_ts
    WHERE command_id = p_command_id;

    -- Record event: RUNNING -> final_status
    INSERT INTO ems_command_events (
      command_id,
      ts,
      from_status,
      to_status,
      message,
      result_json
    ) VALUES (
      p_command_id,
      v_current_ts,
      'RUNNING',
      p_final_status,
      NVL(p_message, 'Command execution completed'),
      p_result_json
    );

  EXCEPTION
    WHEN NO_DATA_FOUND THEN
      RAISE_APPLICATION_ERROR(-20003, 'Command not found: ' || p_command_id);
    WHEN OTHERS THEN
      RAISE;
  END complete_command;

END ems_command_pkg;
/
