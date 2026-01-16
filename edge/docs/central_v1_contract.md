# Edge ↔ Central 契約（Central Ingest v1）

狀態：v1 定版（唯一入口）

本文件定義 Edge 對 Central ingest 的唯一合法呼叫方式與重試/退避行為。

## 1) 唯一入口（REMOVED 舊入口）

- ✅ 唯一合法入口：`POST /ords/ems/ingest/{device_id}`
- ❌ 舊入口視為不存在：`POST /ords/ems/ingest/data`、`POST /ords/ems/ingest/media`

Central v1 **禁止**平行 ingest 入口；Edge 不得再使用或假設舊 endpoint 存在。

## 2) Request（routing 與 body 分離）

### Path param
- `device_id`：routing 唯一來源（同時也是 Central 的 per-device bucket key）

### Headers
- `Content-Type: application/json`
- `X-Idempotency-Key: <uuid-or-hash>`（強烈建議；同一筆資料重送必須穩定不變）

### Body
v1 契約：request body **不得**承載 routing 語義（例如 `device_id`）。

最小格式建議：
```json
{
  "ts": "2026-01-07T05:12:34+08:00",
  "type": "meter_reading",
  "payload": {
    "kwh": 123.45,
    "kw": 3.2
  }
}
```

## 3) Response（Edge 必須處理的 HTTP 行為）

### 202 Accepted（async）
- 意義：Central 已接受（非同步處理）；Edge **不得**等待「處理完成」才視為成功。
- Edge 行為：可將該筆資料標記為成功送達（避免重送造成風暴）。

> 註：成功判斷以 response body 為主（Central 會回 `ok=true` 與狀態欄位）。

### 429 Too Many Requests + Retry-After（per-device rate limit）
- 意義：此 `device_id` 節流。
- Edge 行為：**必須**遵守 `Retry-After`（秒）退避後再重送；不得立刻重送。

### 503 Service Unavailable + Retry-After（global overload）
- 意義：Central 全域過載保護。
- Edge 行為：**必須**遵守 `Retry-After`（秒）退避後再重送；不得立刻重送。

## 4) Retry / Backoff 規則（硬性）

- Edge 不得假設：
  - `200` 一定代表已處理完成
  - ingest 失敗可以立刻重送
- Edge 必須：
  - 尊重 `Retry-After`（秒），作為下一次嘗試的最早時間
  - 對無 `Retry-After` 的暫時性錯誤（例如 5xx）使用指數退避（exponential backoff）並設上限

## 5) 必須移除的舊假設（檢核清單）

- [ ] 任何硬編碼 `/ingest/data` 的 URL
- [ ] 以 `HTTP 200` 作為成功唯一判斷
- [ ] 失敗後「立刻重送」且不看 `Retry-After`
- [ ] request body 內包含 `device_id` 作為 routing
