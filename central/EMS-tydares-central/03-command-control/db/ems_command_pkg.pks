-- Package Specification: ems_command_pkg
--
-- Purpose:
-- Command / Control / Action (CCA) package for managing commands and their lifecycle.
-- All status transitions MUST be recorded in ems_command_events.
-- This package ensures atomic operations and auditability.

CREATE OR REPLACE PACKAGE ems_command_pkg AS

  -- Type definitions
  TYPE t_command_record IS RECORD (
    command_id      VARCHAR2(128),
    command_type    VARCHAR2(128),
    payload_json    CLOB
  );

  -- Create a new command
  -- Returns the generated command_id
  FUNCTION create_command(
    p_device_id         IN VARCHAR2,
    p_command_type      IN VARCHAR2,
    p_payload_json      IN CLOB,
    p_priority          IN NUMBER DEFAULT 50,
    p_not_before_ts     IN TIMESTAMP DEFAULT NULL,
    p_expire_ts         IN TIMESTAMP DEFAULT NULL,
    p_idempotency_key   IN VARCHAR2 DEFAULT NULL,
    p_issued_by         IN VARCHAR2
  ) RETURN VARCHAR2;

  -- Poll for commands (atomic select + update)
  -- Returns command record if found, NULL otherwise
  FUNCTION poll_command(
    p_device_id         IN VARCHAR2,
    o_command_record    OUT t_command_record
  ) RETURN NUMBER; -- Returns 1 if command found, 0 otherwise

  -- Complete a command (report execution result)
  PROCEDURE complete_command(
    p_command_id        IN VARCHAR2,
    p_final_status      IN VARCHAR2,
    p_result_json       IN CLOB DEFAULT NULL,
    p_message           IN VARCHAR2 DEFAULT NULL
  );

END ems_command_pkg;
/
