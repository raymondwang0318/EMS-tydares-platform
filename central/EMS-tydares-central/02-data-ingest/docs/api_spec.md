# 02-data-ingest API（Phase 1.5 最小規格）

Source of truth：Platform repo 文件
- `docs/api/ingest-data.md`
- `docs/api/error-codes.md`

本資料夾保留的是 Central 端落地時的參考版本（盡量與 platform docs 同步）。

## POST /ingest/{device_id}

> DEPRECATED/REMOVED: `POST /ingest/data`（v1 不允許平行入口）

### Request headers（建議）
- `Content-Type: application/json`
- `X-Idempotency-Key: <uuid-or-hash>`

### Path params
- `device_id`：bucket key（routing 唯一來源）

### Body（最小）
v1 契約：request body **不得**承載 routing 語義（例如 `device_id`）。
```json
{
  "ts": "2026-01-07T05:12:34+08:00",
  "type": "meter_reading",
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

v1 契約：成功回應以 `202 Accepted` 為主（非同步處理）；Edge **不得**假設 `200` 代表已處理完成。

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

## Removed

- `POST /ingest/data`：REMOVED（請改用 `POST /ingest/{device_id}`）
- `POST /ingest/media`：REMOVED（v1 不提供平行 ingest 入口）

## 錯誤碼
請見 `docs/api/error-codes.md`（platform repo）。

## Edge contract notes
- `503`/`429` 時必須遵守 `Retry-After`（秒），不得立刻重送
- `202` 表示已接受（非同步），Edge 不得等待「處理完成」才視為成功

