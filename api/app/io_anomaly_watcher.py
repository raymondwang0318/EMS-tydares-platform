"""遠端 I/O 啟動異常 watcher（老王 2026-06-05）.

判斷遠端 I/O 風扇「DO 已輸出但設備未運轉」異常，並發布通知到事件紀錄（ems_events）。

老王設計（2026-06-05）：
- 運轉與否看「DO 輸出」（指令真的下達）；DI 運轉為輔助驗證設備是否真實完成啟動。
- 流程：通知 DO 輸出 → 讀 DO 狀態（ON=運轉中）→ 讀 DI 運轉狀態判斷是否正常運轉中
  → DO=ON 但 DI 運轉=OFF（讀回尚未觸發）= 設備異常 = 發警告通知。
- 寬限期 20s（馬達啟動有物理延遲；DO ON 後 DI 運轉須在 20s 內觸發，否則異常）。
- DI 運轉回 ON 或 DO 回 OFF → 異常解除 → 發恢復事件。

部署：ems-worker 單實例 asyncio task（同 alert_evaluator pattern；多 worker 待轉 Redis state）。
事件落 ems_events（event_kind='operation'）；DB trigger fn_notify_event 自動 pg_notify
'ems_event_operation' → admin-ui 事件履歷頁即時可見。

對應表：app.constants.io_topology.FAN_TEMPLATE
  do_channel → trx_reading parameter_code `do_ch{N}_state`（tcs300b04-{edge}-slave4）
  di_channels.run → `di_ch{N}_state`（tcs300b03-{edge}-slave{di_slave}）
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone

from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.constants.io_topology import FAN_TEMPLATE

log = logging.getLogger("io_anomaly_watcher")

TICK_SEC = 10.0          # 掃描週期
GRACE_SEC = 20.0         # DO ON 後 DI 運轉須在此秒數內觸發，否則判異常（老王 2026-06-05）
STALE_SEC = 120          # trx_reading 超過此秒數無資料 → 視為無狀態 skip（避免誤判）

# in-memory state：(edge_id, fan_id) -> {"since": datetime, "fired": bool}
# Phase 1 單 worker OK；多 worker 部署需轉 Redis（同 alert_evaluator 註記）。
_mismatch_state: dict[tuple[str, str], dict] = {}

# M-PM-323 軌 E：per-edge watcher 排除（M-P10D-032 §4.1；老王 2026-06-09 現場 ground truth）
# ⚠️ 僅作用於本 watcher 評估迴圈；不改 FAN_TEMPLATE 本體（FAN_TEMPLATE 同時餵 admin-ui
#    操作頁 list_fans_template，E17 MS 風扇實體仍在、DI 訊號保留參考、UI 不動＝老王 M-P10D-029）。
# E21(B4)：負壓 3/4 設備不存在（老王 6/9）→ 永無 DI run → 完全排除
# E17(A3)：負壓 5/6 + 內循環 3 = MS 改接，DO 控制不到實體（M-P10D-029 §五）→ 排除
# ⚠️ 未來線路復原須回頭移除對應 fan_id（latent stale-config；長期靠 ems_io_point_map config 化）
WATCHER_FAN_EXCLUSIONS: dict[str, set[str]] = {
    "TYDARES-E21": {"fan_np_3", "fan_np_4"},
    "TYDARES-E17": {"fan_np_5", "fan_np_6", "fan_cir_3"},
}


async def _latest_state(db, device_id: str, parameter_code: str) -> int | None:
    """查 trx_reading 最新一筆 channel state（STALE_SEC 內）；回 0/1，或 None（無資料）。"""
    row = (await db.execute(text("""
        SELECT value FROM trx_reading
        WHERE device_id = :d AND parameter_code = :p
          AND ts > NOW() - make_interval(secs => :stale)
        ORDER BY ts DESC LIMIT 1
    """), {"d": device_id, "p": parameter_code, "stale": STALE_SEC})).fetchone()
    if row is None or row[0] is None:
        return None
    return 1 if float(row[0]) >= 0.5 else 0


async def io_anomaly_tick(session_factory: async_sessionmaker) -> None:
    """單次掃描：對每育成 edge × 每風扇 判斷 DO/DI mismatch，發/解 ems_events。"""
    async with session_factory() as db:
        now = datetime.now(timezone.utc)
        fired = resolved = 0
        # 老王 2026-06-05「全佈署 E02~E22 全部都要」：掃全 fleet edge（不限育成）。
        # 遠端 I/O 風扇實體目前只在育成 E17-E22；其餘 edge 無 tcs300b04 DO 資料 →
        # _latest_state 回 None → 整風扇 skip（無害；未來任何 edge 加裝風扇自動納入）。
        edge_rows = (await db.execute(
            text("SELECT edge_id FROM ems_edge ORDER BY edge_id")
        )).fetchall()
        for (edge_id,) in edge_rows:
            excluded = WATCHER_FAN_EXCLUSIONS.get(edge_id, set())
            for fan in FAN_TEMPLATE:
                fan_id = fan["fan_id"]
                # M-PM-323 軌 E：排除設備不存在/MS 改接 DO 控制不到的點位（清殘留 state，同下方 do_state is None pattern）
                if fan_id in excluded:
                    _mismatch_state.pop((edge_id, fan_id), None)
                    continue
                do_dev = f"tcs300b04-{edge_id}-slave4"
                di_dev = f"tcs300b03-{edge_id}-slave{fan['di_slave']}"
                do_param = f"do_ch{fan['do_channel']}_state"
                run_param = f"di_ch{fan['di_channels']['run']}_state"

                do_state = await _latest_state(db, do_dev, do_param)
                run_state = await _latest_state(db, di_dev, run_param)

                key = (edge_id, fan_id)
                # 無 DO 資料（風扇不存在 / 無 ingest）→ skip + 清 state（不誤判）
                if do_state is None:
                    _mismatch_state.pop(key, None)
                    continue

                # 異常條件：DO 已輸出(ON) 但 DI 運轉明確為 OFF（run_state==0）。
                # run_state is None（DI 無資料）→ 不判異常（避免 DI ingest lag 誤報）。
                mismatch = (do_state == 1 and run_state == 0)
                st = _mismatch_state.get(key)

                if mismatch:
                    if st is None:
                        _mismatch_state[key] = {"since": now, "fired": False}
                    elif not st["fired"] and (now - st["since"]).total_seconds() >= GRACE_SEC:
                        await _fire_anomaly(db, edge_id, do_dev, fan, do_param, run_param)
                        st["fired"] = True
                        fired += 1
                else:
                    # 恢復（DO OFF 或 DI 運轉 ON）→ 若先前已 fire，發解除事件
                    if st is not None and st.get("fired"):
                        await _resolve_anomaly(db, edge_id, do_dev, fan, run_state)
                        resolved += 1
                    _mismatch_state.pop(key, None)

        await db.commit()
        if fired or resolved:
            log.info("io_anomaly tick: fired=%d resolved=%d", fired, resolved)


async def _fire_anomaly(db, edge_id, do_dev, fan, do_param, run_param) -> None:
    msg = (
        f"{fan['label']} 啟動異常：DO 已輸出（{do_param}=ON）但 DI 運轉未觸發"
        f"（{run_param}=OFF）超過 {int(GRACE_SEC)}s，設備可能未真實啟動"
    )
    data = {
        "fan_id": fan["fan_id"], "fan_label": fan["label"],
        "do_channel": fan["do_channel"], "di_run_channel": fan["di_channels"]["run"],
        "anomaly": "do_di_mismatch",
    }
    await db.execute(text("""
        INSERT INTO ems_events
            (event_kind, severity, edge_id, device_id, actor, message, data_json)
        VALUES
            ('operation', 'error', :edge_id, :device_id, 'io_anomaly_watcher',
             :msg, CAST(:data AS JSONB))
    """), {
        "edge_id": edge_id, "device_id": do_dev, "msg": msg,
        "data": json.dumps(data, ensure_ascii=False),
    })
    log.warning("IO anomaly fired: edge=%s fan=%s", edge_id, fan["label"])


async def _resolve_anomaly(db, edge_id, do_dev, fan, run_state) -> None:
    reason = "DI 運轉已觸發" if run_state == 1 else "DO 已關閉"
    msg = f"{fan['label']} 啟動異常解除（{reason}）"
    data = {
        "fan_id": fan["fan_id"], "fan_label": fan["label"],
        "anomaly": "do_di_mismatch_resolved",
    }
    await db.execute(text("""
        INSERT INTO ems_events
            (event_kind, severity, edge_id, device_id, actor, message, data_json)
        VALUES
            ('operation', 'info', :edge_id, :device_id, 'io_anomaly_watcher',
             :msg, CAST(:data AS JSONB))
    """), {
        "edge_id": edge_id, "device_id": do_dev, "msg": msg,
        "data": json.dumps(data, ensure_ascii=False),
    })
    log.info("IO anomaly resolved: edge=%s fan=%s", edge_id, fan["label"])


async def io_anomaly_watcher_loop(session_factory: async_sessionmaker) -> None:
    """主 loop：每 TICK_SEC 跑一次 io_anomaly_tick；異常不終止 loop。"""
    log.info(
        "io_anomaly_watcher_loop started (tick=%ss grace=%ss; 老王 2026-06-05)",
        TICK_SEC, GRACE_SEC,
    )
    while True:
        try:
            await io_anomaly_tick(session_factory)
        except Exception as e:  # pragma: no cover
            log.exception("io_anomaly tick failed: %s", e)
        await asyncio.sleep(TICK_SEC)
