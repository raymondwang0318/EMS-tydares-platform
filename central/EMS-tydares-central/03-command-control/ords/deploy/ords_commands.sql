BEGIN
  ORDS.define_module(
    p_module_name    => 'commands',
    p_base_path      => '/commands/',
    p_items_per_page => 0
  );

  -- POST /commands
  -- Purpose: UI creates a new command
  -- Behavior:
  --   - Creates COMMANDS record (status = QUEUED)
  --   - Creates COMMAND_EVENTS record (NULL -> QUEUED)
  -- This handler is a thin HTTP shell. All command semantics are implemented in ems_command_pkg.

  ORDS.define_template(
    p_module_name => 'commands',
    p_pattern     => ''
  );

  ORDS.define_handler(
    p_module_name => 'commands',
    p_pattern     => '',
    p_method      => 'POST',
    p_source_type => ORDS.source_type_plsql,
    p_source      => q'[
/*
This ORDS handler is a thin HTTP shell.
All command semantics are implemented in ems_command_pkg.
*/

DECLARE
  v_request_body     CLOB;
  v_device_id        VARCHAR2(64);
  v_command_type     VARCHAR2(128);
  v_payload_json     CLOB;
  v_priority         NUMBER := 50;
  v_not_before_ts    TIMESTAMP;
  v_expire_ts        TIMESTAMP;
  v_idempotency_key  VARCHAR2(128);
  v_issued_by        VARCHAR2(128);
  
  v_command_id       VARCHAR2(128);
  v_response_json    CLOB;
BEGIN
  -- 1) Read request body
  v_request_body := :body;

  -- 2) Parse JSON using APEX_JSON (Oracle 12.2+)
  -- Expected format:
  -- {
  --   "device_id": "...",
  --   "command_type": "relay.set",
  --   "payload": {...},
  --   "priority": 50,
  --   "not_before_ts": "2026-01-27T10:00:00",
  --   "expire_ts": "2026-01-27T12:00:00",
  --   "idempotency_key": "...",
  --   "issued_by": "admin"
  -- }
  
  BEGIN
    APEX_JSON.PARSE(v_request_body);
    
    v_device_id := APEX_JSON.get_varchar2(p_path => 'device_id');
    v_command_type := APEX_JSON.get_varchar2(p_path => 'command_type');
    v_payload_json := APEX_JSON.get_clob(p_path => 'payload');
    v_priority := NVL(APEX_JSON.get_number(p_path => 'priority'), 50);
    v_issued_by := NVL(APEX_JSON.get_varchar2(p_path => 'issued_by'), 'system');
    v_idempotency_key := APEX_JSON.get_varchar2(p_path => 'idempotency_key');
    
    -- Parse timestamps if provided
    BEGIN
      v_not_before_ts := TO_TIMESTAMP_TZ(
        APEX_JSON.get_varchar2(p_path => 'not_before_ts'),
        'YYYY-MM-DD"T"HH24:MI:SS'
      );
    EXCEPTION
      WHEN OTHERS THEN
        v_not_before_ts := NULL;
    END;
    
    BEGIN
      v_expire_ts := TO_TIMESTAMP_TZ(
        APEX_JSON.get_varchar2(p_path => 'expire_ts'),
        'YYYY-MM-DD"T"HH24:MI:SS'
      );
    EXCEPTION
      WHEN OTHERS THEN
        v_expire_ts := NULL;
    END;
  EXCEPTION
    WHEN OTHERS THEN
      ORDS.set_status(400);
      :body := '{"error":"Invalid JSON format: ' || SQLERRM || '"}';
      RETURN;
  END;

  -- 3) Validate required fields
  IF v_device_id IS NULL OR v_command_type IS NULL THEN
    ORDS.set_status(400);
    :body := '{"error":"Missing required fields: device_id and command_type"}';
    RETURN;
  END IF;

  -- 4) Delegate to DB package
  v_command_id := ems_command_pkg.create_command(
    p_device_id       => v_device_id,
    p_command_type    => v_command_type,
    p_payload_json    => v_payload_json,
    p_priority        => v_priority,
    p_not_before_ts   => v_not_before_ts,
    p_expire_ts       => v_expire_ts,
    p_idempotency_key => v_idempotency_key,
    p_issued_by       => v_issued_by
  );

  -- 5) Return response
  ORDS.set_status(201);
  v_response_json := '{"status":"created","command_id":"' || v_command_id || '"}';
  :body := v_response_json;

EXCEPTION
  WHEN OTHERS THEN
    ORDS.set_status(500);
    :body := '{"error":"Internal server error: ' || SQLERRM || '"}';
END;
]'
  );

  -- GET /commands/poll?device_id=XXX
  -- Purpose: Edge polls for commands
  -- Behavior (must be atomic in single transaction):
  --   - Selects command matching criteria (device_id, status=QUEUED, not expired, not_before_ts <= now)
  --   - Updates status to DELIVERED
  --   - Creates COMMAND_EVENTS record (QUEUED -> DELIVERED)
  --   - Returns command content
  -- This handler is a thin HTTP shell. All polling semantics are implemented in ems_command_pkg.

  ORDS.define_template(
    p_module_name => 'commands',
    p_pattern     => 'poll'
  );

  ORDS.define_handler(
    p_module_name => 'commands',
    p_pattern     => 'poll',
    p_method      => 'GET',
    p_source_type => ORDS.source_type_plsql,
    p_source      => q'[
/*
This ORDS handler is a thin HTTP shell.
All polling semantics are implemented in ems_command_pkg.
Polling is atomic: select + update happens in single transaction.
*/

DECLARE
  v_device_id        VARCHAR2(64);
  v_command_record   ems_command_pkg.t_command_record;
  v_found            NUMBER;
  v_response_json    CLOB;
BEGIN
  -- 1) Extract query parameter
  v_device_id := :device_id;

  -- 2) Validate required parameter
  IF v_device_id IS NULL THEN
    ORDS.set_status(400);
    :body := '{"error":"Missing required parameter: device_id"}';
    RETURN;
  END IF;

  -- 3) Delegate to DB package (atomic poll)
  v_found := ems_command_pkg.poll_command(
    p_device_id      => v_device_id,
    o_command_record => v_command_record
  );

  -- 4) Return response
  IF v_found = 1 THEN
    ORDS.set_status(200);
    -- Build JSON response
    -- Note: payload_json is already a JSON string, so we embed it directly
    v_response_json := '{' ||
      '"command_id":"' || v_command_record.command_id || '",' ||
      '"command_type":"' || v_command_record.command_type || '",' ||
      '"payload":' || NVL(v_command_record.payload_json, 'null') ||
      '}';
    :body := v_response_json;
  ELSE
    ORDS.set_status(204); -- No Content
    :body := NULL;
  END IF;

EXCEPTION
  WHEN OTHERS THEN
    ORDS.set_status(500);
    :body := '{"error":"Internal server error: ' || SQLERRM || '"}';
END;
]'
  );

  -- POST /commands/{command_id}/complete
  -- Purpose: Edge reports command execution result
  -- Input:
  --   - final_status (SUCCEEDED / FAILED)
  --   - result_json (optional)
  --   - message (optional)
  -- Behavior:
  --   - Updates COMMANDS.status
  --   - Creates COMMAND_EVENTS record (RUNNING -> final_status)
  -- This handler is a thin HTTP shell. All completion semantics are implemented in ems_command_pkg.

  ORDS.define_template(
    p_module_name => 'commands',
    p_pattern     => ':command_id/complete'
  );

  ORDS.define_handler(
    p_module_name => 'commands',
    p_pattern     => ':command_id/complete',
    p_method      => 'POST',
    p_source_type => ORDS.source_type_plsql,
    p_source      => q'[
/*
This ORDS handler is a thin HTTP shell.
All completion semantics are implemented in ems_command_pkg.
*/

DECLARE
  v_command_id       VARCHAR2(128);
  v_request_body     CLOB;
  v_final_status     VARCHAR2(32);
  v_result_json      CLOB;
  v_message          VARCHAR2(2000);
  v_response_json    CLOB;
BEGIN
  -- 1) Extract path parameter
  v_command_id := :command_id;

  -- 2) Read request body
  v_request_body := :body;

  -- 3) Parse JSON using APEX_JSON
  -- Expected format:
  -- {
  --   "final_status": "SUCCEEDED" | "FAILED",
  --   "result_json": {...},
  --   "message": "..."
  -- }
  
  BEGIN
    APEX_JSON.PARSE(v_request_body);
    v_final_status := APEX_JSON.get_varchar2(p_path => 'final_status');
    v_result_json := APEX_JSON.get_clob(p_path => 'result_json');
    v_message := APEX_JSON.get_varchar2(p_path => 'message');
  EXCEPTION
    WHEN OTHERS THEN
      ORDS.set_status(400);
      :body := '{"error":"Invalid JSON format: ' || SQLERRM || '"}';
      RETURN;
  END;

  -- 4) Validate required fields
  IF v_command_id IS NULL OR v_final_status IS NULL THEN
    ORDS.set_status(400);
    :body := '{"error":"Missing required fields: command_id (path) and final_status (body)"}';
    RETURN;
  END IF;

  IF v_final_status NOT IN ('SUCCEEDED', 'FAILED') THEN
    ORDS.set_status(400);
    :body := '{"error":"Invalid final_status. Must be SUCCEEDED or FAILED"}';
    RETURN;
  END IF;

  -- 5) Delegate to DB package
  ems_command_pkg.complete_command(
    p_command_id   => v_command_id,
    p_final_status => v_final_status,
    p_result_json  => v_result_json,
    p_message      => v_message
  );

  -- 6) Return response
  ORDS.set_status(200);
  v_response_json := '{"status":"updated","command_id":"' || v_command_id || '"}';
  :body := v_response_json;

EXCEPTION
  WHEN OTHERS THEN
    -- Check for application errors
    IF SQLCODE = -20001 OR SQLCODE = -20002 OR SQLCODE = -20003 THEN
      ORDS.set_status(400);
      :body := '{"error":"' || SQLERRM || '"}';
    ELSE
      ORDS.set_status(500);
      :body := '{"error":"Internal server error: ' || SQLERRM || '"}';
    END IF;
END;
]'
  );

END;
/
