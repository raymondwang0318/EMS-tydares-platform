# EMS Tydares Platform – 責任邊界圖（文字版）

本文件用來明確定義 **Edge / Central / Ingest / EMS 業務層** 的責任邊界，
避免後續開發時角色混淆、功能漂移或重工。

本邊界在「Edge 與 Central 硬體尚未到位」階段即先行鎖定，
屬於設計基準文件（Design Baseline）。

---

## 一、系統角色總覽

```

[ Devices / Sensors ]
│
▼
┌────────┐
│  Edge  │  Raspberry Pi 4B + 128G SD
└────────┘
│   (HTTP / JSON, 有 retry / queue)
▼
┌──────────────────┐
│ Central Ingest   │  ORDS + Oracle DB
│ (raw / inbox)   │
└──────────────────┘
│   (非同步搬運)
▼
┌──────────────────┐
│ EMS Clean Layer  │  業務可用資料
└──────────────────┘
│
▼
┌──────────────────┐
│ EMS UI / API     │  APEX / Web
└──────────────────┘

```

---

## 二、Edge（邊緣收集站）的責任

### Edge **必須負責**
- 與實體設備通訊（Modbus RTU / TCP）
- 採集原始量測資料
- 產生 **idempotency key**
- 本地 SQLite queue（斷線不死）
- Retry / backoff（避免狂轟 Central）
- 將資料以 HTTP POST 傳送至 Central ingest
- 僅依 Central ACK（stored / duplicate / rejected）決定 queue 行為

### Edge **嚴禁負責**
- ❌ EMS 用電計算（kWh 彙總、日/月報）
- ❌ 跨設備/跨站點資料關聯
- ❌ 中央資料完整性判斷
- ❌ UI 呈現給使用者
- ❌ 判斷資料「業務上是否合理」

> 原則一句話：  
> **Edge 只確保「資料活著送到中央」，不判斷資料的業務意義。**

---

## 三、Central Ingest（資料接收層）的責任

### Central Ingest **必須負責**
- 提供穩定的 HTTP 接收端點（ORDS）
- 驗證基本 header（X-Site-Id / X-Edge-Id / X-Idempotency-Key）
- 依 idempotency key 去重
- 將 payload 原樣寫入 ingest inbox（raw）
- 回傳明確 ACK：
  - stored
  - duplicate
  - rejected
- 保證「寫入 or 不寫入」結果明確

### Central Ingest **嚴禁負責**
- ❌ EMS 業務計算
- ❌ 資料清洗 / 正規化
- ❌ 彙總 / 報表
- ❌ UI 查詢效能最佳化
- ❌ 判斷資料物理或邏輯正確性

> 原則一句話：  
> **Ingest 只是一個「可信任的入口」，不是 EMS 大腦。**

---

## 四、Clean / EMS 業務層的責任（尚未實作）

### EMS Clean Layer **將來必須負責**
- 從 ingest inbox 非同步搬運資料
- 資料清洗、正規化、補欄位
- 用電計算（kWh、尖峰、平均）
- 設備狀態、告警、規則引擎
- 提供 EMS UI / API 使用的資料結構

### EMS Clean Layer **嚴禁影響**
- ❌ ingest 接收效能
- ❌ Edge 上報節奏
- ❌ raw 資料的原始性

> 原則一句話：  
> **EMS 壞掉，Ingest 也必須照收資料。**

---

## 五、資料流的唯一通道規則

### 唯一合法資料流

```

Device → Edge → Central Ingest → Clean Layer → EMS UI

```

### 嚴禁的捷徑
- ❌ Edge → EMS Clean table
- ❌ Edge → EMS UI
- ❌ EMS UI 直接讀 ingest inbox 做業務
- ❌ Ingest 寫入時順便算 kWh

---

## 六、硬體前提下的設計假設

### Central Server（研華工業電腦）
- 長時間開機、穩定供電
- 適合承擔：
  - Oracle DB
  - ORDS
  - 非同步 background job
- 不假設高頻重啟

### Edge（Raspberry Pi 4B + SD Card）
- 可能斷電、斷線、重啟
- SD Card 為耗材（必須減少寫放大）
- 所有設計以「資料不丟」優先於「即時」

---

## 七、邊界鎖定宣告（Design Lock）

- 本文件定義之責任邊界，在 **Edge 與 Central 硬體實際上線前不變更**
- 後續任何需求若違反本邊界，需明確評估並更新本文件

文件狀態：
- Version: v0.1
- Status: Design Baseline Locked
