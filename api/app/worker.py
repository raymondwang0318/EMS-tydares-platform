"""V2-final Worker (ADR-026 DR-026-01).

職責：
1. 讀 ems_ingest_inbox 未處理記錄（processed_at IS NULL）
2. 依 source_type 展平 payload → 寫入 trx_reading
3. 標 processed_at 讓 inbox 之後可清理
4. 每 5 分鐘清除超過 1 小時且已處理的 inbox 記錄

Usage:
    python -m app.worker
"""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timezone

from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.config import settings

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("worker")

BATCH_SIZE = 200
POLL_INTERVAL_SEC = 2.0
INBOX_RETENTION_SEC = 3600        # 1 小時
CLEANUP_INTERVAL_SEC = 300        # 5 分鐘


def _ts_from_ms(ts_ms: int | None, fallback: datetime) -> datetime:
    if ts_ms is None:
        return fallback
    try:
        return datetime.fromtimestamp(int(ts_ms) / 1000.0, tz=timezone.utc)
    except (TypeError, ValueError):
        return fallback


def _flatten_modbus(payload: dict, msg_ts: datetime, device_id: str) -> list[dict]:
    """Modbus payload 展平。

    V2-final IngestRecord 格式（ADR-026; P10 T-P10-007 對齊；正規路徑）:
        {"metric": <code>, "value": <num>, "unit": <str>}

    歷史格式（已 deprecated; 保留 fallback 以防舊資料 / 其他來源）:
        - circuits 巢狀: {"circuits": {"Ma": {"voltage": 220.5}}}
        - 扁平 (legacy): {"voltage": ..., "active_power": ..., "circuit_code": "Ma"}

    Bug fix 2026-04-25 (T-P12-009, M-PM-071):
        原 fallback 扁平邏輯 `for k, v in payload.items()` 把 dict key 名 "value"
        當 parameter_code 寫入，導致 trx_reading 240K rows 全 parameter_code='value'。
        新增 V2-final 分支優先處理 {"metric", "value"} pair；
        legacy fallback 改為**僅 `circuit_code` 在 payload 時才走**（避免誤判 V2-final）。
    """
    rows: list[dict] = []

    # V2-final IngestRecord (ADR-026; P10 T-P10-007 對齊；正規路徑)
    if "metric" in payload and "value" in payload:
        if isinstance(payload["value"], (int, float)):
            rows.append({
                "ts": msg_ts,
                "device_id": device_id,
                "circuit_code": payload.get("circuit_code", "Ma"),
                "parameter_code": payload["metric"],
                "value": float(payload["value"]),
                "quality": 0,
            })
        # value 非 int/float 則靜默 skip
        return rows

    # 歷史 circuits 巢狀
    if isinstance(payload.get("circuits"), dict):
        for circuit_code, params in payload["circuits"].items():
            if not isinstance(params, dict):
                continue
            for param_code, value in params.items():
                if not isinstance(value, (int, float)):
                    continue
                rows.append({
                    "ts": msg_ts,
                    "device_id": device_id,
                    "circuit_code": circuit_code,
                    "parameter_code": param_code,
                    "value": float(value),
                    "quality": 0,
                })
        return rows

    # 歷史扁平 fallback (legacy; deprecated)
    # 守門：必須有 circuit_code 才走（避免誤判 V2-final 漏網 case）
    if "circuit_code" in payload:
        circuit_code = payload["circuit_code"]
        for param_code, value in payload.items():
            if param_code in ("circuit_code", "timestamp", "ts", "ts_ms"):
                continue
            if not isinstance(value, (int, float)):
                continue
            rows.append({
                "ts": msg_ts,
                "device_id": device_id,
                "circuit_code": circuit_code,
                "parameter_code": param_code,
                "value": float(value),
                "quality": 0,
            })
    return rows


def _flatten_ir(payload: dict, msg_ts: datetime, device_id: str) -> list[dict]:
    """熱像 summary 展平（max/min/avg temp + max_coord row/col）.

    M-PM-102 Bug 7 補展平 max_coord：payload["max_coord"] = {"row": int, "col": int}（0-7）
    拆兩個 numeric parameter_code（max_coord_row / max_coord_col）入 trx_reading；
    讓 thermal endpoint mode=history 可 SQL aggregate（同 metric pattern）。

    Refs: ADR-025 DR-025-02 max_coord 0-7；T-Reports-001 §AC 2.4 thermal 履歷座標 column；
    ADR-028 §8.1 L3 卡幀偵測（同像素同值連續幀）需 max_coord 軌跡。
    """
    rows: list[dict] = []
    for param_code in ("max_temp", "min_temp", "avg_temp"):
        if param_code in payload and isinstance(payload[param_code], (int, float)):
            rows.append({
                "ts": msg_ts,
                "device_id": device_id,
                "circuit_code": "_all",
                "parameter_code": param_code,
                "value": float(payload[param_code]),
                "quality": 0,
            })

    # M-PM-102 Bug 7: max_coord {"row", "col"} 拆兩 numeric metric
    mc = payload.get("max_coord")
    if isinstance(mc, dict):
        if isinstance(mc.get("row"), (int, float)):
            rows.append({
                "ts": msg_ts,
                "device_id": device_id,
                "circuit_code": "_all",
                "parameter_code": "max_coord_row",
                "value": float(mc["row"]),
                "quality": 0,
            })
        if isinstance(mc.get("col"), (int, float)):
            rows.append({
                "ts": msg_ts,
                "device_id": device_id,
                "circuit_code": "_all",
                "parameter_code": "max_coord_col",
                "value": float(mc["col"]),
                "quality": 0,
            })
    return rows


async def process_batch(session_factory: async_sessionmaker) -> tuple[int, int]:
    """處理一批 inbox 未處理記錄。回傳 (成功筆數, 失敗筆數)。

    Fix 2026-04-22 (T-P12-002, M-PM-022 裁決 b):
    原邏輯 flatten 失敗也標 processed_at 導致「資料丟失」違反 AC。改為：
    - 成功 → processed_at = NOW()
    - 失敗 → error_message = '...'（不動 processed_at），讓 row 留在 Inbox 供人工檢視
    - SELECT 加 `AND error_message IS NULL` 避免失敗 row 被無限重抓
    """
    async with session_factory() as db:
        result = await db.execute(
            text("""
                SELECT idemp_key, edge_id, device_id, source_type, msg_ts, payload_json
                FROM ems_ingest_inbox
                WHERE processed_at IS NULL
                  AND error_message IS NULL
                ORDER BY received_at
                FOR UPDATE SKIP LOCKED
                LIMIT :limit
            """),
            {"limit": BATCH_SIZE},
        )
        rows = result.fetchall()
        if not rows:
            return (0, 0)

        processed_keys: list[str] = []
        error_entries: list[dict] = []
        reading_rows: list[dict] = []

        for row in rows:
            idemp_key, edge_id, device_id, source_type, msg_ts, payload = row
            try:
                if source_type == "modbus" and device_id:
                    reading_rows.extend(_flatten_modbus(payload or {}, msg_ts, device_id))
                elif source_type == "ir" and device_id:
                    reading_rows.extend(_flatten_ir(payload or {}, msg_ts, device_id))
                # 其他 source_type（relay_state 等）暫不展平，直接標 processed
                processed_keys.append(idemp_key)
            except Exception as e:
                log.warning("flatten failed key=%s err=%s", idemp_key, e)
                # M-PM-022 (b): 留 Inbox + error_message + 不標 processed_at
                error_msg = f"flatten_failed: {type(e).__name__}: {str(e)[:500]}"
                error_entries.append({"idemp_key": idemp_key, "error_msg": error_msg})

        # 批次插入 trx_reading（ON CONFLICT 不需要，hypertable 無 UNIQUE）
        if reading_rows:
            await db.execute(
                text("""
                    INSERT INTO trx_reading
                        (ts, device_id, circuit_code, parameter_code, value, quality)
                    VALUES
                        (:ts, :device_id, :circuit_code, :parameter_code, :value, :quality)
                """),
                reading_rows,
            )

        # 成功項標 processed_at
        if processed_keys:
            await db.execute(
                text("""
                    UPDATE ems_ingest_inbox
                    SET processed_at = NOW()
                    WHERE idemp_key = ANY(:keys)
                """),
                {"keys": processed_keys},
            )

        # 失敗項標 error_message（不動 processed_at）
        if error_entries:
            await db.execute(
                text("""
                    UPDATE ems_ingest_inbox
                    SET error_message = :error_msg
                    WHERE idemp_key = :idemp_key
                """),
                error_entries,
            )

        await db.commit()
        return (len(processed_keys), len(error_entries))


async def cleanup_inbox(session_factory: async_sessionmaker) -> int:
    """清理已處理超過 1 小時的 inbox 記錄。

    Fix 2026-04-22 (T-P12-002, M-PM-022 裁決 A):
    原 SQL `(:sec || ' seconds')::interval` 會讓 asyncpg adapter 推斷 $1 為 str,
    Python int 3600 觸發 asyncpg.DataError (invalid input for query argument $1:
    3600 (expected str, got int))。改為 PostgreSQL 原生 make_interval() constructor,
    asyncpg 推 $1 為 int,型別匹配。
    """
    async with session_factory() as db:
        result = await db.execute(
            text("""
                DELETE FROM ems_ingest_inbox
                WHERE processed_at IS NOT NULL
                  AND received_at < NOW() - make_interval(secs => :sec)
            """),
            {"sec": INBOX_RETENTION_SEC},
        )
        await db.commit()
        return result.rowcount or 0


async def main():
    engine = create_async_engine(settings.database_url, pool_size=5, max_overflow=5)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    log.info("V2-final worker starting (ADR-026)")
    last_cleanup = time.monotonic()

    # T-S11C-002 Phase β: alert evaluator loop（ADR-028 §8）
    # 同 container 的 asyncio task；單 worker 部署 OK，多 worker 待轉 Redis state
    from app.alert_evaluator import alert_evaluator_loop
    alert_task = asyncio.create_task(alert_evaluator_loop(session_factory))
    log.info("alert_evaluator launched (T-S11C-002 ADR-028)")

    try:
        while True:
            success, failed = await process_batch(session_factory)
            if success or failed:
                log.info("batch: success=%d failed=%d", success, failed)
            if (success + failed) == 0:
                await asyncio.sleep(POLL_INTERVAL_SEC)

            # 週期清理
            if time.monotonic() - last_cleanup > CLEANUP_INTERVAL_SEC:
                deleted = await cleanup_inbox(session_factory)
                log.info("cleanup tick: deleted=%d old inbox rows", deleted)
                last_cleanup = time.monotonic()
    finally:
        alert_task.cancel()
        try:
            await alert_task
        except (asyncio.CancelledError, Exception):
            pass
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
