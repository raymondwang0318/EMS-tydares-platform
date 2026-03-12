# Command / Control / Action (CCA) Module

## 概述

本模組實作 Central Platform 的命令/控制/動作（CCA）功能，提供可稽核的命令模型，讓 Edge 節點可以安全地拉取命令並回報執行狀態。

## 設計原則

- ✅ **所有狀態轉移可追蹤**：每次狀態變更都必須記錄在 `ems_command_events` 表中
- ✅ **原子操作**：poll 操作使用單一交易完成 select + update
- ✅ **不破壞既有設計**：完全獨立於 ingest_v1，不影響現有 ingest pipeline
- ✅ **Thin HTTP Shell**：ORDS handlers 僅作為 HTTP 介面，所有邏輯在 DB package 中

## 資料庫設計

### 表結構

#### ems_commands（命令主表）
- `command_id` (PK): 命令唯一識別碼（UUID 格式）
- `device_id` (FK): Edge 節點識別
- `command_type`: 命令類型（例：relay.set）
- `payload_json`: 命令內容（JSON）
- `status`: 狀態（QUEUED / DELIVERED / RUNNING / SUCCEEDED / FAILED / EXPIRED / CANCELED）
- `priority`: 優先級（預設 50）
- `not_before_ts`: 最早執行時間
- `expire_ts`: 過期時間
- `idempotency_key`: 冪等性鍵值（可選）
- `issued_by`: 發佈者
- `created_at`, `updated_at`: 時間戳記

#### ems_command_events（命令事件表）
- `event_id` (PK): 事件唯一識別碼（自動遞增）
- `command_id` (FK): 關聯的命令
- `ts`: 事件時間戳記
- `from_status`: 來源狀態
- `to_status`: 目標狀態
- `message`: 事件訊息
- `result_json`: 執行結果（JSON）

### 狀態流程

```
NULL → QUEUED → DELIVERED → RUNNING → SUCCEEDED/FAILED
```

所有狀態轉移都會在 `ems_command_events` 中記錄。

## API Endpoints

### 1. POST /ords/ems/commands
**用途**：UI 建立命令

**請求範例**：
```json
{
  "device_id": "device-001",
  "command_type": "relay.set",
  "payload": {
    "relay_id": 1,
    "state": "on"
  },
  "priority": 50,
  "not_before_ts": "2026-01-27T10:00:00",
  "expire_ts": "2026-01-27T12:00:00",
  "idempotency_key": "optional-uuid",
  "issued_by": "admin"
}
```

**行為**：
- 建立 COMMANDS 記錄（status = QUEUED）
- 建立 COMMAND_EVENTS 記錄（NULL → QUEUED）
- 支援 idempotency_key 去重

### 2. GET /ords/ems/commands/poll?device_id=XXX
**用途**：Edge 拉取命令（原子操作）

**行為**（單一交易完成）：
- 選取符合條件的命令：
  - device_id 匹配
  - status = QUEUED
  - not_before_ts <= now（或 NULL）
  - 未過期（expire_ts > now 或 NULL）
  - 按優先級降序、建立時間升序排序
- 同時更新 status → DELIVERED
- 寫入 COMMAND_EVENTS（QUEUED → DELIVERED）
- 使用 `FOR UPDATE SKIP LOCKED` 防止競爭條件

**回應**：
- 200 OK：返回命令內容
- 204 No Content：無可用命令

### 3. POST /ords/ems/commands/{command_id}/complete
**用途**：Edge 回報執行結果

**請求範例**：
```json
{
  "final_status": "SUCCEEDED",
  "result_json": {
    "execution_time_ms": 150,
    "actual_state": "on"
  },
  "message": "Relay set successfully"
}
```

**行為**：
- 如果當前狀態是 DELIVERED，先轉換為 RUNNING（並記錄事件）
- 更新 COMMANDS.status 為 final_status
- 寫入 COMMAND_EVENTS（RUNNING → final_status）

## 部署順序

1. **資料庫 Schema**
   ```sql
   -- 1. 建立表
   @oracle-schema/command_tables.sql
   
   -- 2. 建立索引
   @oracle-schema/command_indexes.sql
   ```

2. **資料庫 Package**
   ```sql
   -- 1. Package Specification
   @db/ems_command_pkg.pks
   
   -- 2. Package Body
   @db/ems_command_pkg.pkb
   ```

3. **ORDS Endpoints**
   ```sql
   @ords/deploy/ords_commands.sql
   ```

## 驗證檢查清單

- [x] 所有狀態轉移都有事件記錄
- [x] poll 操作是原子的（單一交易）
- [x] 使用 `FOR UPDATE SKIP LOCKED` 防止競爭
- [x] 支援 idempotency_key 去重
- [x] ORDS handlers 是 thin HTTP shell
- [x] 不影響 ingest_v1 pipeline
- [x] 所有 SQL 都是 idempotent / transaction-safe

## 不支援事項

❌ **本模組不負責設備實際控制**  
❌ **不保證命令一定成功**  
✅ **僅保證「命令派發與結果記錄的正確性」**

本模組僅提供命令的派發、追蹤與稽核機制。實際的設備控制邏輯由 Edge 端實作，本模組不介入設備的實際操作。

## 注意事項

1. **命令模型只描述「意圖」**：不直接控制設備，僅描述要執行的動作
2. **不引入 UI 或 Edge 相依**：本模組完全獨立
3. **狀態轉移不可隱式發生**：所有狀態變更都必須通過 package 函數，並記錄事件
4. **過期處理**：目前未實作自動過期機制，可在後續加入排程任務處理 EXPIRED 狀態

## 後續擴充建議

- [ ] 自動過期處理（排程任務）
- [ ] 命令取消功能（CANCELED 狀態）
- [ ] 命令重試機制
- [ ] 命令執行超時處理
- [ ] 命令歷史查詢 API
