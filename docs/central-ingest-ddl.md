# Central ingest 最小 DDL（Phase 1.5）

來源：Central 專案 DDL 檔
- `central/EMS-tydares-central/02-data-ingest/db/ingest_inbox.sql`
- `central/EMS-tydares-central/02-data-ingest/db/media_inbox.sql`

## ingest_inbox 最小欄位
- `idemp_key` (PK)
- `site_id`
- `edge_id`
- `device_id`
- `received_at`
- `payload_json`
- `payload_sha256`（可選）

## Indexes
- `(received_at)`
- `(site_id, edge_id, received_at)`
