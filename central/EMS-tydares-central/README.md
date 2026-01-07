# EMS-tydares-central

中央應用平台（Central）專案骨架：Oracle DB + APEX + ORDS + 媒體服務 + EMS domain。

## Modules
- `01-core-platform`: 穩定通用核心（識別、字典、健康檢查、心跳）
- `02-data-ingest`: Edge → Central 接收層（去重、ACK、Inbox）
- `03-ems-application`: EMS 業務邏輯（計算、警報、報表準備）
- `04-media-services`: 影像/溫度/附件（存放規則與查詢）
- `05-web-ui`: APEX / custom UI
- `06-infra-devops`: docker、ssl、備份、環境

## Conventions (draft)
- **SQL 檔案**：以 module 分類，DDL 與 package/endpoints 分開
- **表命名**：`ems_<domain>`（例：`ems_ingest_inbox`）
- **Idempotency**：一律使用 `(edge_id, idempotency_key)` 做唯一邊界

## Getting started
- 先落地 `01-core-platform/oracle-schema` 與 `02-data-ingest/db` DDL
- 再補 ORDS module 定義，將 endpoints 接到 package function
