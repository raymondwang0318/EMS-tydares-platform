# EMS-tydares-platform

本專案為「tydares 農改場」EMS 平台總倉（Platform Repo），包含 Edge 邊緣收集站與 Central 中央平台的最小可運行架構。

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
- `/ingest/data` 接收 JSON
- idempotency 去重
- 回 ACK（stored/duplicate/rejected）
- raw data 落地 `ingest_inbox`

### Phase 2 以後（後續擴充）
- EMS 業務計算（kwh/kw/報表/告警）
- Media 影像/溫度事件
- APEX/自製 UI

---

## API 規格（最小）

- 規格入口：`docs/api/ingest-data.md`
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
