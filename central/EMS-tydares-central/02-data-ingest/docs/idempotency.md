# Idempotency (draft)

## Key
- Header：`X-Site-Id`、`X-Edge-Id`、`X-Idempotency-Key`
- DB：`ems_ingest_inbox.idemp_key` / `ems_media_inbox.idemp_key` 為 PK。
- `X-Idempotency-Key` 建議使用 UUIDv4 或內容雜湊（同一筆訊息重送必須相同）。

## Expected behavior
- First request inserts row, returns ACK `stored`.
- Replayed request returns ACK `duplicate`.
- `duplicate` 不視為錯誤；Edge 應把它當作「Central 已收件」的成功情境。

## Notes
- Do not perform EMS calculations here.
- Raw data 先落 `payload_json`，後續處理（clean/domain）再由排程/worker 做。

## Minimal replay strategy (Edge)
- Edge 本地 buffer 每筆訊息都要保存 `X-Idempotency-Key`。
- 上報成功（`stored|duplicate`）才可從 buffer 移除。
- 遇到網路錯誤/timeout 直接重送同一把 key。
