# Central Ingest API 最小規格（Phase 1.5）

Central 只做：接收、去重、回 ACK、存 raw。

## POST /ingest/data

### Request headers（建議）
- `Content-Type: application/json`
- `X-Site-Id: tydares`
- `X-Edge-Id: edge-01`
- `X-Idempotency-Key: <uuid-or-hash>`（強烈建議）

### Body（最小）

```json
{
  "ts": "2026-01-07T05:12:34+08:00",
  "type": "meter_reading",
  "device_id": "gateway-01",
  "payload": {
    "meter_id": "AEM-01",
    "kwh": 1234.56,
    "kw": 3.21,
    "v": 220.1,
    "a": 14.6
  }
}
```

### Response（ACK 統一格式）

✅ 成功（新寫入）

```json
{
  "ok": true,
  "status": "stored",
  "idempotency_key": "...",
  "server_time": "2026-01-07T05:12:35+08:00"
}
```

✅ 成功（重複：已存在）

```json
{
  "ok": true,
  "status": "duplicate",
  "idempotency_key": "...",
  "server_time": "2026-01-07T05:12:35+08:00"
}
```

❌ 失敗（格式錯/缺欄位）

```json
{
  "ok": false,
  "status": "rejected",
  "error_code": "BAD_REQUEST",
  "message": "missing field: ts"
}
```

## POST /ingest/media

Phase 2 才會用到也行，但先留規格。

建議做法：
- `multipart/form-data`
- 同樣支援 `X-Idempotency-Key`
