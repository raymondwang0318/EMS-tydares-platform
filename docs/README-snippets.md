# README Snippets

這份文件只放「可貼回 README.md」的片段，避免 README 過長。

## API 最小規格
- `POST /ingest/{device_id}`
  - Header: `X-Idempotency-Key`（建議）
  - Response: `{ ok, status: stored|duplicate|rejected, ... }`

錯誤碼請見 `docs/api/error-codes.md`。
