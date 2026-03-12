# ORDS Deploy - Command / Control / Action (CCA)

## Deploy order
1. Deploy Oracle schema:
   - `../oracle-schema/command_tables.sql`
   - `../oracle-schema/command_indexes.sql`
2. Deploy DB packages:
   - `../db/ems_command_pkg.pks`
   - `../db/ems_command_pkg.pkb`
3. Deploy ORDS endpoints:
   - `ords_commands.sql`

## Endpoints

### POST /ords/ems/commands
**Purpose**: UI creates a new command

**Request Body**:
```json
{
  "device_id": "device-001",
  "command_type": "relay.set",
  "payload": {
    "relay_id": 1,
    "state": "on"
  },
  "priority": 50,
  "not_before_ts": "2026-01-27T10:00:00",
  "expire_ts": "2026-01-27T12:00:00",
  "idempotency_key": "optional-uuid",
  "issued_by": "admin"
}
```

**Response** (201 Created):
```json
{
  "status": "created",
  "command_id": "generated-uuid"
}
```

**Behavior**:
- Creates COMMANDS record (status = QUEUED)
- Creates COMMAND_EVENTS record (NULL -> QUEUED)
- All logic in `ems_command_pkg.create_command`

---

### GET /ords/ems/commands/poll?device_id=XXX
**Purpose**: Edge polls for commands (atomic operation)

**Query Parameters**:
- `device_id` (required): Edge device identifier

**Response** (200 OK with command):
```json
{
  "command_id": "uuid",
  "command_type": "relay.set",
  "payload": {...}
}
```

**Response** (204 No Content):
- No commands available for this device

**Behavior** (atomic in single transaction):
- Selects command matching:
  - device_id matches
  - status = QUEUED
  - not_before_ts <= now (or NULL)
  - not expired (expire_ts > now or NULL)
  - Highest priority first, then oldest first
- Updates status to DELIVERED
- Creates COMMAND_EVENTS record (QUEUED -> DELIVERED)
- Returns command content
- Uses `FOR UPDATE SKIP LOCKED` to prevent race conditions
- All logic in `ems_command_pkg.poll_command`

---

### POST /ords/ems/commands/{command_id}/complete
**Purpose**: Edge reports command execution result

**Path Parameters**:
- `command_id` (required): Command identifier

**Request Body**:
```json
{
  "final_status": "SUCCEEDED",
  "result_json": {
    "execution_time_ms": 150,
    "actual_state": "on"
  },
  "message": "Relay set successfully"
}
```

**Response** (200 OK):
```json
{
  "status": "updated",
  "command_id": "uuid"
}
```

**Behavior**:
- Updates COMMANDS.status to final_status
- If current status is DELIVERED, first transitions to RUNNING
- Creates COMMAND_EVENTS record (RUNNING -> final_status)
- All logic in `ems_command_pkg.complete_command`

---

## Notes
- All handlers are thin HTTP shells; business logic lives in `ems_command_pkg`
- All status transitions are recorded in `ems_command_events`
- Polling is atomic (single transaction: select + update)
- Commands are idempotent if `idempotency_key` is provided
- Status flow: QUEUED -> DELIVERED -> RUNNING -> SUCCEEDED/FAILED
