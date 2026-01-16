# Edge MVP 功能清單 + DONE 條件（Phase 1）

目的：Edge 先「跑得起來、斷線不死、資料不掉」，Central 先「接得住」。

## 必須做到的 5 件事

1. 能穩定讀到設備資料
   - Modbus RTU / TCP（依現場設備）

2. 有本地暫存（Buffer/Queue）
   - SQLite（建議）或可落地的 queue 機制

3. 能判斷網路是否可用
   - 能偵測 Central endpoint 是否可達（timeout/HTTP status）

4. 能呼叫 Central API
   - `POST /ingest/{device_id}`（v1 唯一入口）

5. 能收到 ACK 並正確處理
   - `202`（Accepted, async）：視同成功（已被 Central 接受），可刪除 buffer
   - `stored`：標記 sent，可刪除 buffer
   - `duplicate`：視同成功（Central 已收件），可刪除 buffer
   - `rejected`：丟 dead-letter（不重試）
   - `503 SERVICE_UNAVAILABLE` + `Retry-After`：全域過載，必須退避重試
   - `429 RATE_LIMIT` + `Retry-After`：per-device 節流，必須退避重試

## DONE（可驗收）
- 斷網 1 小時：資料仍持續入 buffer、程式不崩
- 恢復網路：會自動補送，且不會造成重複資料（靠同一把 `X-Idempotency-Key`）
- 重啟 Edge：buffer 不遺失，且仍可繼續補送
- Central 回 `duplicate` 時，Edge 行為與 `stored` 相同
- Edge 不得假設 `200` 代表已處理完成；成功判斷以 `202` 與回應 body 為主
