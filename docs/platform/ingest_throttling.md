# Central Platform – Ingest Anti‑Storm（防通訊風暴）設計

狀態：Draft（Design Baseline 候選）  
最後更新：2026-01-16

封版宣告：本文件之 **附錄 A** 為 Central Ingest 的 **Implementation Blueprint**；實作不得偏離附錄 A 所述語義。若需變更行為或一致性保證點，必須先修改附錄 A（並同步更新本文件日期與相關段落）。

本文件定義 Central（Oracle DB + ORDS）在面對多個 Edge 節點同時恢復連線、集中 flush queue 時的自我保護（Anti‑Storm）設計：
- Central 永遠不因瞬間大量上報而當機
- 接收層（Ingest）與核心資料層（Core/Clean）解耦
- 可針對單一 `device_code`（本文等同 payload 的 `device_id`）做節流
- ingest endpoint 可水平擴展（多 ORDS 節點）

> 與現有文件對齊：
> - ingest API 基線：`docs/api/ingest-data.md`
> - Idempotency：`central/EMS-tydares-central/02-data-ingest/docs/idempotency.md`
> - Error codes：`docs/api/error-codes.md`

---

## 0. 背景與威脅模型

### 已知風險
- 多個 Edge 可能同時恢復連線並大量 flush queue（同步 burst）。
- 單一 Edge 不一定守規矩（bug / 設定錯誤 / 無限重送）。
- Central 必須具備「不信任客戶端」前提下的自我保護能力。

### Anti‑Storm 的核心策略
1. **快速拒絕（Fast Reject）**：在最小成本下判斷是否要收（429/503）。
2. **接收即落地（Durable Staging）**：只做最小處理，落地到 inbox/staging，回 202（或相容期回 200）。
3. **非同步搬運（Async Workers）**：由背景 worker 批次寫入核心表與業務層，與接收解耦。
4. **可局部節流（Per-device Throttle）**：能針對單一 `device_code` 限速，避免壞裝置拖垮整體。

---

## 1. 架構總覽（接收層與核心層解耦）

```
Edge (queue/batch/backoff)
        |
        |  HTTP POST /ingest/data
        v
+---------------------+
|  ORDS Ingest Layer  |  (水平擴展，多節點)
|  - auth/basic check |
|  - per-device RL    |  (共享 DB state)
|  - idempotency      |
|  - minimal parse    |
+----------+----------+
           |
           |  INSERT raw
           v
+---------------------+
|  ems_ingest_inbox    |  (staging/inbox)
|  - append-mostly     |
|  - status/attempts   |
+----------+----------+
           |
           |  poll batch
           v
+---------------------+
| Background Workers  |
| - clean/validate    |
| - write core tables |
| - retry/DLQ         |
+---------------------+
```

設計重點：**Ingest 永遠不直接同步寫核心表**；核心表寫入只在 worker 執行。

---

## 2. Ingest 接收層行為設計

本節定義 `/ingest/data`（及同型 endpoint）在風暴期間的具體行為。

### 2.1 最小處理原則（必須）
Ingest 層只做以下事情：
- 驗證必要 header：`X-Site-Id`、`X-Edge-Id`、`X-Idempotency-Key`
- 解析 payload 的最小欄位以取得 `device_code`（`device_id`）與 `ts/type`（目前已在 `ems_ingest_pkg.ingest_data` 做）
- **執行 per-device rate limit**（見 2.2）
- **執行 idempotency**（去重）
- **將 raw payload 寫入 inbox**（staging）
- 回應 ACK（202/429/400/…）

嚴禁：
- ❌ 同步寫核心表（domain / clean / reporting tables）
- ❌ 執行 EMS 計算或資料清洗

### 2.2 每 device_code 的速率限制（Per-device Rate Limit）

#### 目標
- 壞掉的單一裝置/edge 不會拖垮整體。
- 多個 ORDS 節點下仍一致（**所有節流狀態必須在 DB 層共享**）。

#### 建議演算法：Token Bucket（資料庫共享狀態）
- 每個 `device_code` 有一個 bucket：容量 $C$、補充速率 $R$ tokens/sec。
- 每次請求消耗 1 token（或依 payload size/批次大小調整 cost）。
- token 不足時拒絕並回 `429 RATE_LIMIT`，附 `Retry-After`。

#### 參數建議（起始值）
- `C = 10`（允許瞬間小 burst）
- `R = 1` req/sec（平滑寫入）

> 參數應可依 site/edge/device 分層覆寫（例如重要裝置較高、測試裝置較低）。

#### DB 實作要求（水平擴展關鍵）
- Rate limit 必須是「跨 ORDS 節點一致」：
  - ✅ 以 Oracle table 儲存 bucket state（每 device 一列），以原子 `UPDATE/MERGE` 消耗 token
  - ✅ 允許多 session 併發
  - ✅ O(1) 讀寫（index 命中）
- 避免每次請求做昂貴 lock：
  - 不建議在熱路徑依賴全局鎖；可用 row-level lock/原子 update 即可。

> 附錄 A 提供建議的 DB 物件與更新邏輯（偽碼）。

### 2.3 回應 202 / 429 的策略

#### 200 → 202 過渡期規則（必須落成）

考量 Edge、既有測試腳本與監控可能已依賴 `200`，Central 需採「兩階段」切換，避免雙邊不同步造成誤判。

- **Phase 1（相容期）**：HTTP 維持回 `200`，但 response body 的 `status` 仍回 `stored|duplicate`（欄位不變）。
- **Phase 2（切換期）**：HTTP 改回 `202`（Accepted），**response body 欄位完全不變**，仍回 `stored|duplicate`。
- **Edge/測試/監控的唯一判斷規則**：一律以 response body 的 `status` 判斷成功與否，**不得以 HTTP code 判斷**（HTTP code 只用於分類錯誤：429/503/400/…）。

> 本規則的目的：讓 Central 與 Edge 任一方尚未升級時，系統行為仍一致、可預期。

#### 202 Accepted（成功收件 / 可去重）
當 Central「已接受並確保落地（或已判定為 duplicate）」時回 `202`。

**回 202 的條件（任一成立）：**
- 新訊息：已寫入 inbox
- 重送：idempotency key 已存在（duplicate）

建議回應 body（維持現有 ACK 格式精神，可擴充欄位）：
```json
{
  "ok": true,
  "status": "stored|duplicate",
  "idempotency_key": "...",
  "server_time": "2026-01-16T12:34:56+08:00"
}
```

> 相容性說明：現有文件與 `ems_ingest_pkg` 以 `200 stored/duplicate` 為基線；
> 本 anti-storm 設計建議升級為 `202`（語意更精準）。若短期需相容，也可先維持 200，
> 但 Edge 的行為應以 `status=stored|duplicate` 為準，而非僅看 HTTP code。

#### 429 Too Many Requests（節流）
當 Central 判定「此 `device_code` 超出允許速率」時回 `429`，並提供可機械判讀的退避資訊。

要求：
- `error_code` 固定為 `RATE_LIMIT`（對齊 `docs/api/error-codes.md`）
- 提供 `Retry-After` header（秒）
- body 必須可讓 Edge 明確知道是「可重試」

範例：
- Header：`Retry-After: 3`
- Body：
```json
{
  "ok": false,
  "status": "rejected",
  "error_code": "RATE_LIMIT",
  "message": "device throttled",
  "retry_after_sec": 3
}
```

#### 503 Service Unavailable（全域過載/保護模式）
當 Central 全域資源（DB/UNDO/IO/worker backlog）接近風險門檻，可進入保護模式：
- 回 `503` 或更嚴格的 `429`（全域節流）
- 同樣提供 `Retry-After`

> 原則：寧願短暫拒收，也不要讓 DB 崩潰導致長時間不可用。

**最小可操作門檻（至少要有一個，建議以 inbox backlog 為準）**

Central 可用 DB 自己就能量測的條件啟動保護模式（不依賴外部監控）：
- 當 `ems_ingest_inbox` 的 `NEW` backlog > `X`
  - 例：`X = 100000`（起始值，需依環境校正）
- 或當 `NEW backlog / worker_rate` > `Y` 分鐘（代表處理落後）
  - 例：`Y = 30` 分鐘

觸發後行為：
- Ingest 回 `503 SERVICE_UNAVAILABLE`（或全域 `429`）+ `Retry-After`
- 直到 backlog 降到安全水位以下（例如 < `0.7 * X` 或 < `0.7 * Y`）才解除（避免震盪）

### 2.4 不同步寫核心表（硬性規則）
Ingest 的交易（transaction）邊界必須只包含：
-（可選）rate limit 消耗
- inbox 去重/寫入

核心表寫入、清洗、彙總、報表，全部移到 worker。

---

## 3. Staging / Inbox 機制設計

### 3.1 接收即落地（最小處理）

現況已存在 `ems_ingest_inbox`（PK = `idemp_key`）並存 `payload_json`：
- `central/EMS-tydares-central/02-data-ingest/db/ingest_inbox.sql`

Anti‑Storm 要求：
- Inbox 寫入必須足夠快、schema 變更要保守。
- Inbox 表設計為 **append-mostly**：大量 INSERT、少量狀態更新。

建議擴充欄位（如後續需要 worker/重試狀態）：
- `process_status`：`NEW|PROCESSING|DONE|ERROR|DLQ`
- `attempts`、`next_attempt_at`：支援重試與退避
- `processed_at`、`last_error_code`、`last_error_msg`

> 若不想擴充原表，可採「狀態表/工作表」：用 `idemp_key` 連回 inbox。

### 3.2 背景 worker 非同步寫入核心表

#### Worker 拉取模式（可水平擴展）
- Worker 以批次拉取 `NEW` 的 inbox row。
- 併發安全：使用 `SELECT ... FOR UPDATE SKIP LOCKED`，允許多 worker 同時跑不互搶。
- 每批處理 $N$ 筆（例如 100/500），每批 commit 一次，避免長交易。

#### 重試與 Dead-letter（必須）
- 可重試錯誤（暫時性）：DB timeout、資源不足、下游依賴短暫不可用
  - 以 `attempts` 做上限（例如 10 次）
  - `next_attempt_at` 做指數退避（例如 1s, 2s, 4s, … + jitter）
- 不可重試錯誤（永久性）：payload 欄位缺失、格式不合法、資料違反 domain 規則
  - 標記 `DLQ`（或寫入 `ems_ingest_dead_letter`）供追查

#### Worker 狀態機（必須定義，避免未來長歪）

狀態集合：`NEW|PROCESSING|DONE|ERROR|DLQ`

狀態轉移與規則（建議最小版）：

| 狀態 | 進入條件 | 退出條件 | 下一步 |
|---|---|---|---|
| NEW | 初次落地或重試到期 | worker 成功 claim | PROCESSING |
| PROCESSING | worker 以 `FOR UPDATE SKIP LOCKED` claim 到該筆 | 處理成功 | DONE |
| PROCESSING | 同上 | 可重試錯誤 | ERROR（並設定 `next_attempt_at`） |
| PROCESSING | 同上 | 不可重試錯誤 | DLQ |
| ERROR | 上次處理失敗且可重試 | 到達 `next_attempt_at` | NEW |
| ERROR | 上次處理失敗且可重試 | `attempts` 達上限 | DLQ |

錯誤分類（預設規則，可調）：
- **可重試（ERROR）**：暫時性錯誤（連線問題、DB 資源不足、鎖等待超時、下游短暫不可用）
- **不可重試（DLQ）**：payload schema 不合法、必要欄位缺失、domain rule 永久不成立、資料明顯無法修復

重試上限（預設值 + 可調）：
- 預設 `attempts_max = 10`，可依 `site/edge/msg_type` 覆寫

退避公式（建議一個可實作的版本）：
- `base_sec = 1`
- `delay = min( base_sec * 2^(attempts-1), 300 )`（上限 5 分鐘）
- `jitter = random(0..0.3)`
- `next_attempt_at = SYSTIMESTAMP + NUMTODSINTERVAL(delay * (1 + jitter), 'SECOND')`

#### Out-of-order 的處理位置
- Ingest 不負責排序。
- 排序/去重/時間窗彙總等「業務一致性」由 worker/clean layer 在核心表處理。

### 3.3 Inbox 體積與保留策略（避免被撐爆）
- 依 `received_at` 做 partition（日/週/月）以利清理與索引維護。
- 設定保留期：例如 raw payload 保留 30/90 天（依法規/需求）。
- 監控 inbox 增長速率與 backlog（NEW 數量）。當 backlog > 門檻時啟動全域保護模式（回 503/429）。

---

## 4. Central 對 Edge 的假設（不信任前提）

Central 必須在以下假設下仍可用：

### 4.1 Edge 可能 burst
- Edge 可能在恢復連線後立刻高頻 flush。
- Central 會透過 per-device rate limit 平滑輸入。

### 4.2 Edge 可能重送
- 可能因 timeout/網路抖動/實作 bug 重送同一筆。
- Central 以 `X-Idempotency-Key`（對應 inbox PK）保證「重送不造成重複入庫」。
- `duplicate` 不視為錯誤，Edge 應視同成功並清 queue。

### 4.3 Edge 可能順序錯亂
- 批次上報、重試、甚至不同 worker 併發，均可能造成 out-of-order。
- Central Ingest 層不保證順序。
- 核心表的正確性必須以 `msg_ts`（及必要時的 sequence/version）在 worker 層設計。

---

## 5. 與 Edge batch/backoff 的配合契約

Edge 若要與 Central Anti‑Storm 協同，必須遵守：
- 收到成功回應（Phase 1 為 `200`、Phase 2 為 `202`）時：**一律以 body 的 `status=stored|duplicate` 判定成功**，可將該 idempotency key 從本地 queue 移除
- 收到 `429 RATE_LIMIT`：
  - 必須尊重 `Retry-After`
  - 必須加 jitter（避免多 edge 同步醒來造成下一波尖峰）
  - 建議退避：`sleep = retry_after * (1 + random(0..0.3))`
- timeout/網路錯誤：重送同一筆必須使用相同 `X-Idempotency-Key`

建議 Edge 上報策略（非強制，但強烈建議）：
- 批次大小限制（例如每批 50~200 筆），批與批之間 sleep
- 針對不同 device 分流（每 device 自己的 rate limit/backoff）

---

## 6. 可觀測性與運維控制（讓防風暴可操作）

至少需要：
- 指標（metrics）
  - 202/429/503 比例（按 site/edge/device）
  - inbox 新增速率、NEW backlog、worker 處理速率
  - 平均/百分位 latency
- 管控（controls）
  - per-device limit 配置（白名單/黑名單/臨時封鎖）
  - 全域保護模式開關（當 DB 風險升高時）

---

## 附錄 A：Rate Limit DB 物件（建議；Status: Normative / Implementation Blueprint）


> 目標：提供「可直接照抄實作」的 Oracle SQL/PLSQL 偽碼，讓多個 ORDS 節點能共享同一份節流/保護狀態。
>
> 一致性總原則（本附錄所有區塊共用）：
> - ✅ **扣 token 必須單一原子語句完成**：只允許 `UPDATE ... RETURNING`（或等價單語句 DML）。
> - ❌ 禁止「先 SELECT 再 UPDATE」兩段式扣減（會 race，且在高併發下容易造成 lock 風暴）。
> - ✅ 狀態轉移（worker state、claim job）同樣必須以單語句 `UPDATE ... WHERE state=... RETURNING` 原子完成。

### A.0 先決條件（Index / Constraint 假設）

```sql
-- 一致性目的：用 PK/UK 讓 upsert 與併發可預期；用索引確保熱路徑 O(1)。

-- Rate limit（每 device 一列）
-- 注意：last_refill_utc 用 DATE（UTC）是為了讓「秒差」計算在 SQL 表達式中可直接落地。
CREATE TABLE ems_ingest_rl_device (
  device_code        VARCHAR2(64)   NOT NULL,
  tokens             NUMBER         NOT NULL,
  capacity           NUMBER         NOT NULL,
  refill_per_sec     NUMBER         NOT NULL,
  last_refill_utc    DATE           NOT NULL,
  blocked_until_utc  DATE,
  updated_at         TIMESTAMP(6)   DEFAULT SYSTIMESTAMP NOT NULL,
  CONSTRAINT pk_ems_ingest_rl_device PRIMARY KEY (device_code)
);

-- 若需依 site/edge/device 覆寫，建議另建設定表（非必須）：
-- ems_ingest_rl_policy(site_id, edge_id, device_code, capacity, refill_per_sec, enabled, ...)

-- Inbox（staging）建議索引：
-- 1) worker claim 熱路徑：status + next_attempt_at
-- 2) backlog/速率統計：status + received_at/processed_at
-- 假設你們已擴充 process_status/next_attempt_at/processed_at 等欄位，或以工作表達成同等效果。
CREATE INDEX ix_ingest_inbox_status_next ON ems_ingest_inbox(process_status, next_attempt_at);
CREATE INDEX ix_ingest_inbox_status_recv ON ems_ingest_inbox(process_status, received_at);
CREATE INDEX ix_ingest_inbox_processed_at ON ems_ingest_inbox(processed_at);

-- 建議（可選）：(process_status, processed_at)
-- 用途：支援附錄 A.2 的 done_per_min window 統計時更穩定走組合索引。
-- CREATE INDEX ix_ingest_inbox_status_processed ON ems_ingest_inbox(process_status, processed_at);
```

### A.0.1 常數與設定（建議：兩層，避免散落與避免 config 破壞一致性）

```plsql
-- 一致性目的：把邊界/上限鎖在程式碼常數，避免被 config 調壞導致節流或重試失控。

CREATE OR REPLACE PACKAGE ems_ingest_constants AS
  -- ACK
  ACK_HTTP_PHASE_200        CONSTANT PLS_INTEGER := 1;
  ACK_HTTP_PHASE_202        CONSTANT PLS_INTEGER := 2;

  -- Retry-After（秒）
  RETRY_AFTER_MIN_SEC       CONSTANT PLS_INTEGER := 1;
  RETRY_AFTER_MAX_SEC       CONSTANT PLS_INTEGER := 30;

  -- Rate limit（token bucket）
  RL_DEFAULT_CAPACITY       CONSTANT NUMBER      := 100;
  RL_DEFAULT_REFILL_PER_SEC CONSTANT NUMBER      := 10;
  RL_COST_PER_REQUEST       CONSTANT NUMBER      := 1;

  -- Global overload
  OVERLOAD_BACKLOG_X        CONSTANT NUMBER      := 1000;
  OVERLOAD_LAG_MIN_Y        CONSTANT NUMBER      := 5;
  OVERLOAD_RATE_WINDOW_MIN  CONSTANT NUMBER      := 1;

  -- Worker retry/backoff
  WORKER_ATTEMPTS_MAX       CONSTANT PLS_INTEGER := 10;
  WORKER_BACKOFF_CAP_SEC    CONSTANT PLS_INTEGER := 300;
  WORKER_JITTER_MAX         CONSTANT NUMBER      := 0.3;
END ems_ingest_constants;
/

-- 一致性目的：集中讀 config 的位置；常數仍由 ems_ingest_constants 保護上限/下限。

CREATE OR REPLACE PACKAGE ems_ingest_settings AS
  FUNCTION get_ack_http_phase RETURN PLS_INTEGER;
  PROCEDURE get_overload_thresholds(
    o_backlog_x       OUT PLS_INTEGER,
    o_lag_min_y       OUT PLS_INTEGER,
    o_rate_window_min OUT PLS_INTEGER
  );
  PROCEDURE get_rl_defaults(
    o_capacity       OUT PLS_INTEGER,
    o_refill_per_sec OUT NUMBER,
    o_cost_per_req   OUT PLS_INTEGER
  );
END ems_ingest_settings;
/

CREATE OR REPLACE PACKAGE BODY ems_ingest_settings AS
  FUNCTION get_ack_http_phase RETURN PLS_INTEGER IS
    v VARCHAR2(256);
  BEGIN
    BEGIN
      SELECT config_value INTO v
        FROM ems_ingest_config
       WHERE config_key = 'ACK_HTTP_PHASE';
      RETURN CASE
        WHEN v = 'PHASE2_202' THEN ems_ingest_constants.ACK_HTTP_PHASE_202
        ELSE ems_ingest_constants.ACK_HTTP_PHASE_200
      END;
    EXCEPTION
      WHEN NO_DATA_FOUND THEN
        RETURN ems_ingest_constants.ACK_HTTP_PHASE_200;
    END;
  END;

  PROCEDURE get_overload_thresholds(
    o_backlog_x       OUT PLS_INTEGER,
    o_lag_min_y       OUT PLS_INTEGER,
    o_rate_window_min OUT PLS_INTEGER
  ) IS
  BEGIN
    -- 偽碼：如需可讀 config，建議做「有值就採用，否則 fallback 常數」。
    o_backlog_x       := ems_ingest_constants.OVERLOAD_BACKLOG_X;
    o_lag_min_y       := ems_ingest_constants.OVERLOAD_LAG_MIN_Y;
    o_rate_window_min := ems_ingest_constants.OVERLOAD_RATE_WINDOW_MIN;
  END;

  PROCEDURE get_rl_defaults(
    o_capacity       OUT PLS_INTEGER,
    o_refill_per_sec OUT NUMBER,
    o_cost_per_req   OUT PLS_INTEGER
  ) IS
  BEGIN
    o_capacity       := ems_ingest_constants.RL_DEFAULT_CAPACITY;
    o_refill_per_sec := ems_ingest_constants.RL_DEFAULT_REFILL_PER_SEC;
    o_cost_per_req   := ems_ingest_constants.RL_COST_PER_REQUEST;
  END;
END ems_ingest_settings;
/
```

### A.1 200 → 202 過渡期（DB 可配置，應用不改語義）

```sql
-- 一致性目的：用單一配置來源避免 Central/Edge/監控不同步時出現判斷分歧。

CREATE TABLE ems_ingest_config (
  config_key   VARCHAR2(64) PRIMARY KEY,
  config_value VARCHAR2(256) NOT NULL,
  updated_at   TIMESTAMP(6) DEFAULT SYSTIMESTAMP NOT NULL
);

-- config_key = 'ACK_HTTP_PHASE'
-- config_value = 'PHASE1_200' 或 'PHASE2_202'

-- 讀取方式（偽碼）：
-- v_ack_phase := ems_ingest_settings.get_ack_http_phase();  -- 回傳 ems_ingest_constants.ACK_HTTP_PHASE_200 / _202
-- 成功（stored/duplicate）時：
--   IF v_ack_phase = ems_ingest_constants.ACK_HTTP_PHASE_200 THEN o_http_code := 200; ELSE o_http_code := 202; END IF;
-- 失敗（429/503/400/401/403...）維持既有 HTTP code。
-- 重要：Edge 永遠以 body.status 判斷成功，不以 HTTP code。
```

### A.2 全域過載門檻（DB 自給自足）與短路行為

```sql
-- 一致性目的：在 DB 進入危險區前先短路（503/429），保護整體可用性；判定只用 DB 可查的指標。

-- 門檻（可放 config）：
-- BACKLOG_X = 100000
-- LAG_MIN_Y = 30
-- RATE_WINDOW_MIN = 5

-- 以單一查詢計算：NEW backlog 與近 RATE_WINDOW 的處理速率
WITH
  cfg AS (
    SELECT
      ems_ingest_constants.OVERLOAD_BACKLOG_X       AS backlog_x,
      ems_ingest_constants.OVERLOAD_LAG_MIN_Y       AS lag_min_y,
      ems_ingest_constants.OVERLOAD_RATE_WINDOW_MIN AS rate_window_min
    FROM dual
  ),
  backlog AS (
    SELECT COUNT(*) AS new_backlog
    FROM ems_ingest_inbox
    WHERE process_status = 'NEW'
  ),
  rate AS (
    SELECT
      COUNT(*) / (SELECT rate_window_min FROM cfg) AS done_per_min
    FROM ems_ingest_inbox
    WHERE process_status = 'DONE'
      AND processed_at >= SYSTIMESTAMP - NUMTODSINTERVAL((SELECT rate_window_min FROM cfg), 'MINUTE')
  )
SELECT
  b.new_backlog,
  r.done_per_min,
  CASE
    WHEN b.new_backlog > (SELECT backlog_x FROM cfg) THEN 1
    WHEN r.done_per_min > 0 AND (b.new_backlog / r.done_per_min) > (SELECT lag_min_y FROM cfg) THEN 1
    ELSE 0
  END AS is_overloaded,
  -- retry-after 建議：用「預估落後分鐘」轉成秒並做 cap
  CASE
    WHEN r.done_per_min <= 0 THEN 30
    ELSE LEAST(30, GREATEST(1, CEIL((b.new_backlog / r.done_per_min) * 60)))
  END AS retry_after_sec
FROM backlog b CROSS JOIN rate r;

-- Ingest 短路（偽碼）：
-- IF is_overloaded=1 THEN
--   o_http_code := 503;
--   o_error_code := 'SERVICE_UNAVAILABLE';
--   o_retry_after_sec := retry_after_sec;
--   RETURN;
-- END IF;

-- 解鎖（hysteresis）規則（避免抖動，必須落成）：
-- 觸發：new_backlog > X 或 new_backlog/done_rate > Y
-- 解除：new_backlog < X_off 且 new_backlog/done_rate < Y_off
-- 建議：X_off = FLOOR(0.7 * X)，Y_off = FLOOR(0.7 * Y)
```

### A.3 Token Bucket：單語句原子扣減（UPDATE ... RETURNING）

```sql
-- 一致性目的：扣 token 完全由單一 UPDATE 原子完成，避免 race；row-level lock 僅鎖住單一 device 的列。
-- 競態避免理由：不做「SELECT tokens → 計算 → UPDATE tokens」兩段式，就不會發生 lost update。

-- 設計規則（必須寫死）：refill 採「整秒」粒度（FLOOR），屬於設計選擇。
-- 目的：避免高頻抖動（sub-second）導致 tokens 微幅增減、增加不必要的鎖競爭與不可預期性。

-- (0) 確保 row 存在（允許併發；靠 PK 保證不會重複）
MERGE INTO ems_ingest_rl_device d
USING (
  SELECT
    :device_code AS device_code,
    10          AS capacity,
    1           AS refill_per_sec
  FROM dual
) s
ON (d.device_code = s.device_code)
WHEN NOT MATCHED THEN
  INSERT (device_code, tokens, capacity, refill_per_sec, last_refill_utc, blocked_until_utc, updated_at)
  VALUES (s.device_code, s.capacity, s.capacity, s.refill_per_sec, CAST(SYS_EXTRACT_UTC(SYSTIMESTAMP) AS DATE), NULL, SYSTIMESTAMP);

-- (1) 嘗試扣 1 token：成功才會 UPDATE（失敗代表 token 不足或被 block）
DECLARE
  v_tokens_after NUMBER;
  v_stmt_now_utc DATE := CAST(SYS_EXTRACT_UTC(SYSTIMESTAMP) AS DATE);
BEGIN
  UPDATE ems_ingest_rl_device d
     SET d.tokens = (
           LEAST(
             d.capacity,
             d.tokens + FLOOR((v_stmt_now_utc - d.last_refill_utc) * 86400 * d.refill_per_sec)
           )
         ) - 1,
         d.last_refill_utc = v_stmt_now_utc,
         d.updated_at = SYSTIMESTAMP
   WHERE d.device_code = :device_code
     AND (d.blocked_until_utc IS NULL OR d.blocked_until_utc <= v_stmt_now_utc)
     AND LEAST(
           d.capacity,
           d.tokens + FLOOR((v_stmt_now_utc - d.last_refill_utc) * 86400 * d.refill_per_sec)
         ) >= 1
  RETURNING d.tokens INTO v_tokens_after;

  IF SQL%ROWCOUNT = 1 THEN
    -- 允許通過：v_tokens_after 是扣減後剩餘 tokens
    :o_allowed := 1;
    :o_retry_after_sec := 0;
    RETURN;
  END IF;

  -- 若扣減失敗：不得再嘗試 UPDATE（避免不必要鎖）；此時只做讀取以計算 Retry-After。
  -- 注意：這不是「兩段式扣減」，因為沒有先 SELECT 再 UPDATE。
  -- 另外：此 SELECT 可能讀到剛被其他 session 更新前/後的 last_refill_utc，導致 retry-after 估算略保守或略樂觀；
  -- 但因 Edge 必須 jitter + backoff，且 retry-after 只做「提示」，因此可接受。
  DECLARE
    v_capacity        NUMBER;
    v_tokens          NUMBER;
    v_refill_per_sec  NUMBER;
    v_last_refill_utc DATE;
    v_blocked_until   DATE;
    v_now_utc         DATE := v_stmt_now_utc;
    v_tokens_after_refill NUMBER;
    v_need_tokens     NUMBER;
    v_delay_sec       NUMBER;
  BEGIN
    SELECT capacity, tokens, refill_per_sec, last_refill_utc, blocked_until_utc
      INTO v_capacity, v_tokens, v_refill_per_sec, v_last_refill_utc, v_blocked_until
      FROM ems_ingest_rl_device
     WHERE device_code = :device_code;

    IF v_blocked_until IS NOT NULL AND v_blocked_until > v_now_utc THEN
      -- 被封鎖：retry-after = (blocked_until - now) 秒，並做 cap
      v_delay_sec := CEIL((v_blocked_until - v_now_utc) * 86400);
    ELSE
      v_tokens_after_refill := LEAST(
        v_capacity,
        v_tokens + FLOOR((v_now_utc - v_last_refill_utc) * 86400 * v_refill_per_sec)
      );

      v_need_tokens := GREATEST(1 - v_tokens_after_refill, 1);

      IF v_refill_per_sec <= 0 THEN
        v_delay_sec := ems_ingest_constants.RETRY_AFTER_MAX_SEC; -- 無法補 token：給一個保守的 retry-after（可配置）
      ELSE
        v_delay_sec := CEIL(v_need_tokens / v_refill_per_sec);
      END IF;
    END IF;

    -- retry-after 邊界（單位：秒；至少 1；上限 30，可配置）
    :o_allowed := 0;
    :o_retry_after_sec := LEAST(
      ems_ingest_constants.RETRY_AFTER_MAX_SEC,
      GREATEST(ems_ingest_constants.RETRY_AFTER_MIN_SEC, v_delay_sec)
    );
  END;
END;
/
```

### A.4 Ingest 入口：全域過載短路 + per-device token bucket + idempotency

```plsql
-- 一致性目的：先保護（503），再節流（429），最後才落地 inbox；讓系統在風暴時可預期且不崩。
-- 競態避免理由：token 扣減用原子 UPDATE；idempotency 用 PK 保證；worker 另行處理避免同步核心寫入。

PROCEDURE ingest_data(
  p_site_id           IN VARCHAR2,
  p_edge_id           IN VARCHAR2,
  p_idempotency_key   IN VARCHAR2,
  p_payload_json      IN CLOB,
  o_status            OUT VARCHAR2,
  o_http_code         OUT NUMBER,
  o_message           OUT VARCHAR2,
  o_retry_after_sec   OUT NUMBER
) IS
  v_ack_phase   VARCHAR2(32);
  v_device_code VARCHAR2(64);
  v_is_overloaded NUMBER;
  v_overload_retry NUMBER;
  v_allowed NUMBER;
  v_rl_retry NUMBER;
BEGIN
  -- (A) 基本檢核（略）

  -- (B) 全域過載短路（503）
  -- SELECT is_overloaded, retry_after_sec INTO v_is_overloaded, v_overload_retry FROM ...（A.2 查詢）
  IF v_is_overloaded = 1 THEN
    o_status := 'rejected';
    o_http_code := 503;
    o_message := 'overloaded';
    o_retry_after_sec := v_overload_retry;
    RETURN;
  END IF;

  -- (C) 解析最小欄位取得 device_code（略：json_value(... '$.device_id' ...)）

  -- (D) per-device rate limit（429）
  -- 呼叫 A.3 的 token bucket 扣減邏輯（allowed/retry_after_sec）
  IF v_allowed = 0 THEN
    o_status := 'rejected';
    o_http_code := 429;
    o_message := 'device throttled';
    o_retry_after_sec := v_rl_retry;
    RETURN;
  END IF;

  -- (E) Idempotent insert（落地 inbox，不同步寫核心表）
  BEGIN
    INSERT INTO ems_ingest_inbox(
      idemp_key, site_id, edge_id, device_id, msg_ts, msg_type, received_at, payload_json,
      process_status, attempts, next_attempt_at
    ) VALUES (
      p_idempotency_key, p_site_id, p_edge_id, v_device_code, /* msg_ts */, /* msg_type */,
      SYSTIMESTAMP, p_payload_json,
      'NEW', 0, SYSTIMESTAMP
    );
    o_status := 'stored';
  EXCEPTION
    WHEN DUP_VAL_ON_INDEX THEN
      o_status := 'duplicate';
  END;

  -- (F) 200 → 202 過渡期：成功一律看 body.status；HTTP code 由 phase 控制
  v_ack_phase := ems_ingest_settings.get_ack_http_phase();

  IF v_ack_phase = ems_ingest_constants.ACK_HTTP_PHASE_200 THEN
    o_http_code := 200;
  ELSE
    o_http_code := 202;
  END IF;

  o_message := o_status;
  o_retry_after_sec := 0;
END;
```

### A.5 Worker 狀態機（READY / BUSY / BACKOFF / DISABLED）與一致性轉移

```sql
-- 一致性目的：worker 的狀態轉移採用單語句原子更新，避免多 worker 同時 claim 或重入。
-- 競態避免理由：不做 SELECT 判斷後再 UPDATE；以「UPDATE ... WHERE state=... RETURNING」完成 Compare-And-Set。

CREATE TABLE ems_ingest_worker (
  worker_id           VARCHAR2(64)  PRIMARY KEY,
  -- 可選：若未來需要更嚴格 CAS 或做審計，增加 lock_version 是常見做法（本設計不強制）。
  lock_version        NUMBER        DEFAULT 0 NOT NULL,
  state               VARCHAR2(16)  NOT NULL,
  last_heartbeat_at   TIMESTAMP(6)  NOT NULL,
  busy_until          TIMESTAMP(6),
  backoff_until       TIMESTAMP(6),
  disabled_reason     VARCHAR2(256),
  consecutive_errors  NUMBER        DEFAULT 0 NOT NULL,
  updated_at          TIMESTAMP(6)  DEFAULT SYSTIMESTAMP NOT NULL,
  CONSTRAINT ck_worker_state CHECK (state IN ('READY','BUSY','BACKOFF','DISABLED'))
);

CREATE INDEX ix_worker_state ON ems_ingest_worker(state);
```

```plsql
-- 一致性目的：將 READY→BUSY 以原子轉移完成，確保同一 worker 不會被誤判為可用。

PROCEDURE worker_try_acquire(p_worker_id IN VARCHAR2, o_acquired OUT NUMBER) IS
  v_now TIMESTAMP(6) := SYSTIMESTAMP;
  v_state VARCHAR2(16);
BEGIN
  UPDATE ems_ingest_worker
     SET state = 'BUSY',
         busy_until = v_now + NUMTODSINTERVAL(60, 'SECOND'),
         last_heartbeat_at = v_now,
         updated_at = v_now
   WHERE worker_id = p_worker_id
     AND state = 'READY'
  RETURNING state INTO v_state;

  o_acquired := CASE WHEN SQL%ROWCOUNT = 1 THEN 1 ELSE 0 END;
END;

-- BUSY→READY：成功完成一批後釋放
PROCEDURE worker_mark_ready(p_worker_id IN VARCHAR2) IS
BEGIN
  UPDATE ems_ingest_worker
     SET state = 'READY',
         busy_until = NULL,
         consecutive_errors = 0,
         updated_at = SYSTIMESTAMP
   WHERE worker_id = p_worker_id
     AND state = 'BUSY';
END;

-- BUSY→BACKOFF：暫時性錯誤（exponential + cap + jitter）
PROCEDURE worker_mark_backoff(p_worker_id IN VARCHAR2, p_attempt IN NUMBER) IS
  v_base_sec NUMBER := 1;
  v_cap_sec  NUMBER := ems_ingest_constants.WORKER_BACKOFF_CAP_SEC;
  v_delay    NUMBER;
  v_jitter   NUMBER;
BEGIN
  v_delay := LEAST(v_cap_sec, v_base_sec * POWER(2, GREATEST(p_attempt-1, 0)));
  v_jitter := DBMS_RANDOM.VALUE(0, ems_ingest_constants.WORKER_JITTER_MAX);

  UPDATE ems_ingest_worker
     SET state = 'BACKOFF',
         backoff_until = SYSTIMESTAMP + NUMTODSINTERVAL(v_delay * (1 + v_jitter), 'SECOND'),
         consecutive_errors = consecutive_errors + 1,
         updated_at = SYSTIMESTAMP
   WHERE worker_id = p_worker_id
     AND state = 'BUSY';
END;

-- 任務迴圈入口：BACKOFF→READY（到期才醒）
PROCEDURE worker_maybe_wake(p_worker_id IN VARCHAR2) IS
BEGIN
  UPDATE ems_ingest_worker
     SET state = 'READY',
         backoff_until = NULL,
         updated_at = SYSTIMESTAMP
   WHERE worker_id = p_worker_id
     AND state = 'BACKOFF'
     AND backoff_until <= SYSTIMESTAMP;
END;

-- 任務永久失敗或人工停用：→DISABLED
PROCEDURE worker_disable(p_worker_id IN VARCHAR2, p_reason IN VARCHAR2) IS
BEGIN
  UPDATE ems_ingest_worker
     SET state = 'DISABLED',
         disabled_reason = p_reason,
         updated_at = SYSTIMESTAMP
   WHERE worker_id = p_worker_id
     AND state <> 'DISABLED';
END;
```

### A.6 Worker 拉取 inbox：SKIP LOCKED claim + 重試退避（可實作骨架）

```plsql
-- 一致性目的：用 SKIP LOCKED 讓多 worker 併發安全；每批短交易避免長鎖。
-- 競態避免理由：row lock + SKIP LOCKED 保證同一筆不會同時被兩個 worker 處理。
-- 硬規則：每批 commit 一次；批次過大會拉長鎖時間並放大風暴效應，需限制 batch_size。

PROCEDURE worker_process_batch(p_worker_id IN VARCHAR2, p_batch_size IN NUMBER DEFAULT 200) IS
  CURSOR c_jobs IS
    SELECT idemp_key
      FROM ems_ingest_inbox
     WHERE process_status = 'NEW'
       AND next_attempt_at <= SYSTIMESTAMP
     ORDER BY received_at
     FETCH FIRST p_batch_size ROWS ONLY
     FOR UPDATE SKIP LOCKED;

  v_attempts NUMBER;
BEGIN
  -- 若全域過載，可選擇讓 worker 進 BACKOFF（避免雪崩）
  -- IF is_overloaded THEN worker_mark_backoff(...); RETURN; END IF;

  FOR r IN c_jobs LOOP
    BEGIN
      -- claim：同一 transaction 內把狀態設為 PROCESSING
      UPDATE ems_ingest_inbox
         SET process_status = 'PROCESSING',
             updated_at = SYSTIMESTAMP
       WHERE idemp_key = r.idemp_key;

      -- 實際處理：解析 raw → 寫核心表（略）

      UPDATE ems_ingest_inbox
         SET process_status = 'DONE',
             processed_at = SYSTIMESTAMP,
             updated_at = SYSTIMESTAMP
       WHERE idemp_key = r.idemp_key;

    EXCEPTION
      WHEN /* 可重試錯誤集合 */ THEN
        SELECT attempts INTO v_attempts FROM ems_ingest_inbox WHERE idemp_key = r.idemp_key FOR UPDATE;

        v_attempts := v_attempts + 1;
        IF v_attempts >= ems_ingest_constants.WORKER_ATTEMPTS_MAX THEN
          UPDATE ems_ingest_inbox
             SET process_status = 'DLQ',
                 attempts = v_attempts,
                 last_error_code = 'RETRY_EXHAUSTED',
                 last_error_msg = SQLERRM,
                 updated_at = SYSTIMESTAMP
           WHERE idemp_key = r.idemp_key;
        ELSE
          -- exponential + cap + jitter
          DECLARE
            v_delay NUMBER := LEAST(ems_ingest_constants.WORKER_BACKOFF_CAP_SEC, POWER(2, v_attempts-1));
            v_jitter NUMBER := DBMS_RANDOM.VALUE(0, ems_ingest_constants.WORKER_JITTER_MAX);
          BEGIN
            UPDATE ems_ingest_inbox
               SET process_status = 'ERROR',
                   attempts = v_attempts,
                   next_attempt_at = SYSTIMESTAMP + NUMTODSINTERVAL(v_delay * (1 + v_jitter), 'SECOND'),
                   last_error_code = 'TRANSIENT',
                   last_error_msg = SQLERRM,
                   updated_at = SYSTIMESTAMP
             WHERE idemp_key = r.idemp_key;
          END;
        END IF;

      WHEN /* 不可重試錯誤集合 */ THEN
        UPDATE ems_ingest_inbox
           SET process_status = 'DLQ',
               last_error_code = 'PERMANENT',
               last_error_msg = SQLERRM,
               updated_at = SYSTIMESTAMP
         WHERE idemp_key = r.idemp_key;
    END;
  END LOOP;

  COMMIT;
END;
```

---

## 附錄 C：Central 端最小可執行變更清單（交付釘子）

> 不要求一次到位，但建議依序完成，才能讓 Anti‑Storm 真正跑起來。

1.（可選/依 Phase）調整 ORDS Ingest 回應碼
  - Phase 1：維持 `200`（相容期），body 仍回 `status=stored|duplicate`
  - Phase 2：切換 `202`，body 欄位不變
2. 新增 per-device rate limit 的資料表（例：`ems_ingest_rl_device`）
3. 在 `ems_ingest_pkg.ingest_data` 的最前面插入 rate-limit 檢查（不足即回 429 + Retry-After）
4. Inbox 增加狀態欄位（或新增工作表）
  - 支援 `process_status/attempts/next_attempt_at/last_error_*`
5. 實作 worker job
  - DB 內：`DBMS_SCHEDULER` + `FOR UPDATE SKIP LOCKED` 批次處理
  - 或外部：service/cron worker（同樣使用 `SKIP LOCKED` 取得工作）
6. 定義並落實全域過載門檻
  - 以 `NEW backlog` 或 `NEW backlog / worker_rate` 觸發保護模式（503/429）

---

## 附錄 B：HTTP 行為對照表（Ingest）

| 情境 | HTTP | status | 說明 | Edge 行為 |
|---|---:|---|---|---|
| 新訊息已落 inbox | 200/202 | stored | 已收件（依 Phase 回 200 或 202） | 從 queue 移除 |
| 重送（已存在） | 200/202 | duplicate | 已收件（不重複寫；依 Phase 回 200 或 202） | 從 queue 移除 |
| 單 device 超速 | 429 | rejected | RATE_LIMIT + Retry-After | 退避重試 |
| 全域過載保護 | 503 | rejected | SERVICE_UNAVAILABLE + Retry-After | 退避重試 |
| payload 不合法 | 400 | rejected | BAD_REQUEST | dead-letter（不重試） |
| 權限問題 | 401/403 | rejected | UNAUTHORIZED/FORBIDDEN | 停止上報 + 告警 |
