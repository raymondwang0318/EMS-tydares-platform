# ORDS Deploy（Phase 1.5）

## Deploy order
1. `ords_enable.sql`
2. `ords_ingest_device.sql`

## Endpoints
- `POST /ords/ems/ingest/{device_id}`

## Notes
- Deprecated/Removed: `/ingest/data`, `/ingest/media` (v1 forbids parallel ingest entrypoints)
- Handler contract: thin HTTP shell only; semantics live in `ems_ingest_entrypoint.handle_ingest`
- v1 freeze: no backwards compatibility; ingest changes must update Edge + Central together
