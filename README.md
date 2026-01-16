# EMS-tydares-platform

本專案為「tydares 農改場」EMS 平台總倉（Platform Repo），包含 Edge 邊緣收集站與 Central 中央平台的最小可運行架構。

## Ingest v1 封版宣告（一次性定版）

本專案目前仍處於設計與建置階段，尚未正式上線；因此本階段允許破壞性變更。
但 **Central ingest 架構已封版為 v1**，後續不得任意漂移：

- 不考慮舊架構相容（舊入口視為 REMOVED）
- 不提供多入口並存（v1 唯一入口：`POST /ingest/{device_id}`）
- ORDS handler 必須是 thin HTTP shell，不得實作商業邏輯
- 所有 ingest 語義必須委派 DB entrypoint：`ems_ingest_entrypoint.handle_ingest`

變更規則：任何 ingest 行為變更，必須同時更新 Edge 與 Central 契約與文件。

## 目標（目前階段）
優先完成 **Edge MVP**，並同步完成 **Central Ingest 最小接收層**，以便在現場進行斷線/補送/去重的真實運行測試。

---

## Repo 結構（建議維持此分層）

```
ems-tydares-platform/
├─ edge/                 # 邊緣收集站（優先開發）
├─ central/              # 中央平台（先做 ingest 接收 + ACK）
├─ infra/                # 佈署（docker/ssl/tunnel/backup）
└─ docs/                 # 架構、規格、SOP
```

---

## 開發優先順序（Phase）

### Phase 1：Edge MVP（現場可跑）
- 採集（Modbus）
- 本地緩存（SQLite queue）
- 上報 Central（HTTP/ORDS）
- 斷線不死、恢復可補送
- 可觀測（log/health）

### Phase 1.5：Central Ingest（接得住即可）
- **v1 唯一入口：**`/ingest/{device_id}` 接收 JSON
- Anti‑Storm（429/503 + Retry-After）
- raw data 落地 inbox（後續由 worker 非同步處理）

### Phase 2 以後（後續擴充）
- EMS 業務計算（kwh/kw/報表/告警）
- Media 影像/溫度事件
- APEX/自製 UI

---

## API 規格（最小）

- 規格入口：`docs/api/ingest-data.md`（v1：`POST /ingest/{device_id}`）
- 錯誤碼：`docs/api/error-codes.md`

---

## 開發約定
- **Edge 永遠不直接寫入 EMS 業務表**
- **Central ingest 只存 raw，不做分析**
- 去重以 `X-Idempotency-Key` 為準（Edge 必須穩定生成）

---

## Roadmap（簡版）
- [ ] Edge MVP 完成並現場測試
- [ ] Central ingest 穩定接收 + 去重 + ACK
- [ ] EMS domain schema v1
- [ ] APEX dashboard v1
