# Ingest v1 Index（封版索引）

狀態：v1 封版（系統尚未上線，可破壞性變更；但 v1 行為不得漂移）

本頁是 ingest v1 的單一索引入口：
- **Normative（不可偏離）**：定義「必須發生什麼」與一致性/順序/禁止事項
- **Implementation（必須服從規範）**：實作必須符合 Normative；任何行為變更先改 Normative

> v1 唯一入口：`POST /ingest/{device_id}`（舊入口已 REMOVED；禁止平行入口）

---

## Normative（不可偏離）

1) 防風暴與一致性藍圖（Authority）
- docs/platform/ingest_throttling.md
  - 附錄 A：Implementation Blueprint（Normative）

2) HTTP 入口流程（順序鎖死）
- docs/platform/ingest_http_flow.md
  - overload → rate limit → inbox → ack
  - 429/503 必須帶 Retry-After（秒）

3) 實作檢核（防語義漂移）
- docs/platform/ingest_implementation_checklist.md

4) 職責邊界（防功能漂移）
- docs/architecture/responsibility-boundary.md

5) Edge ↔ Central v1 契約（Edge 必須跟著走）
- edge/docs/central_v1_contract.md

---

## Implementation（必須服從規範）

### Central（DB packages）
- central/EMS-tydares-central/02-data-ingest/db/
  - ems_ingest_constants (pks/pkb)
  - ems_ingest_settings (pks/pkb)
  - ems_ingest_rate_limit (pks/pkb)
  - ems_ingest_overload (pks/pkb)
  - ems_ingest_entrypoint (pks/pkb)

### Central（ORDS deploy / thin shell）
- central/EMS-tydares-central/02-data-ingest/ords/deploy/ords_enable.sql
- central/EMS-tydares-central/02-data-ingest/ords/deploy/ords_ingest_device.sql
- central/EMS-tydares-central/02-data-ingest/ords/deploy/README.md

---

## 變更規則（硬性）

- 不允許新增平行 ingest 入口（v1 only：`POST /ingest/{device_id}`）
- ORDS handler 只能做 HTTP shell，不得放商業邏輯
- ingest 行為變更必須：
  - 先更新 Normative（尤其附錄 A / flow）
  - 再更新 Central 實作（DB/ORDS）
  - 同步更新 Edge 契約與 Edge 實作
