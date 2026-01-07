# ORDS Deploy（Phase 1.5）

## Deploy order
1. `../ems_ingest_pkg.sql`
2. `ords_enable.sql`
3. `ords_ingest_data.sql`
4. `ords_ingest_media.sql`

## Endpoints
- `POST /ords/ems/ingest/data`
- `POST /ords/ems/ingest/media`

## Notes
- Headers: `X-Site-Id`, `X-Edge-Id`, `X-Idempotency-Key`
- ACK: `stored | duplicate | rejected`
