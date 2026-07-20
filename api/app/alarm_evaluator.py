"""811C 熱像三級閾值告警 evaluator（M-PM-313 階段2 P1）.

老王 2026-06-05 拍板 + M-PM-313S1 雙簽 GO（2026-06-08）：
- 對 811C 熱像「畫面最高溫 max_temp」做三級閾值告警（預設 60 info / 75 warn / 90 critical）。
- 閾值定義於 ems_alarm_rule（rule_type='thermal_temp_exceed'，老王可從 IR 標籤管理頁改）。
- 純 Central worker：max_temp 已在 trx_reading（parameter_code='max_temp'，5 分鐘聚合）
  → 零 Edge 改動（採證 SSOT：01_Edge/811C_熱像max_temp資料路徑_相機到Central_SSOT_2026-06-08）。
- 防洗版（D7）：同一設備只在嚴重度「向上跨越」時才寫新 event，同級/降級不重發。
- critical 自動 notify_pananora=TRUE（讓 Boss UI 讀得到 + 觸發 Mail Worker）。
- 自動解除：設備最高溫 < 60°C（info 閾值）持續 5 分鐘 → 該設備所有未解除 thermal_alarm
  event 填 resolved_at + 寫一筆恢復 info event + 重置狀態（下次升溫可再告警）。

部署：ems-worker 單實例 asyncio task（同 io_anomaly_watcher / alert_evaluator pattern；
多 worker 待轉 Redis state）。事件落 ems_events（event_kind='thermal_alarm'）；DB trigger
fn_notify_event 自動 pg_notify 'ems_event_thermal_alarm' → admin-ui 事件履歷頁即時可見。

⚠️ 區分：本 evaluator 處理「811C IR 熱像畫面溫度」（trx_reading max_temp），
   與「Edge 主機 CPU 溫度」（ems_edge_heartbeat.cpu_temp_c，80/85°C 心跳告警）是不同資料。
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone

from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker

log = logging.getLogger("alarm_evaluator")

TICK_SEC = 60.0            # 掃描週期（max_temp 為 5 分鐘聚合，60s 足夠）
STALE_SEC = 600           # 只看 10 分鐘內最新 max_temp（避免拿過期值誤判）
RESOLVE_BELOW = 60.0      # 自動解除門檻（< info 閾值；M-PM-313 §3.4）
RESOLVE_WINDOW_SEC = 300  # 最高溫須 < RESOLVE_BELOW 持續此秒數才解除（5 分鐘）

_SEV_RANK = {"info": 1, "warn": 2, "critical": 3}

# in-memory state：device_id -> 目前已告警的最高嚴重度（'info'/'warn'/'critical'）
# 單 worker OK；多 worker 待轉 Redis（同 io_anomaly_watcher 註記）。
# loop 啟動時由 _init_state_from_db() 從未解除 event 重建 → worker 重啟不重複告警/不漏解除。
_thermal_state: dict[str, str] = {}
_initialized = False


async def _init_state_from_db(db) -> None:
    """從 DB 未解除 thermal_alarm event 重建 in-memory 狀態（重啟安全）。"""
    rows = (await db.execute(text("""
        SELECT device_id, severity
        FROM ems_events
        WHERE event_kind = 'thermal_alarm'
          AND actor = 'alarm_evaluator'
          AND resolved_at IS NULL
          AND severity IN ('info','warn','critical')
    """))).fetchall()
    for device_id, severity in rows:
        prev = _thermal_state.get(device_id)
        if prev is None or _SEV_RANK.get(severity, 0) > _SEV_RANK.get(prev, 0):
            _thermal_state[device_id] = severity
    log.info("alarm_evaluator state rebuilt from DB: %d device(s) with active thermal alarm", len(_thermal_state))


async def _latest(db, device_id: str, parameter_code: str):
    """查 trx_reading 最新一筆（STALE_SEC 內）；回 (value:float, ts:datetime) 或 None。"""
    row = (await db.execute(text("""
        SELECT value, ts FROM trx_reading
        WHERE device_id = :d AND parameter_code = :p
          AND ts > NOW() - make_interval(secs => :stale)
        ORDER BY ts DESC LIMIT 1
    """), {"d": device_id, "p": parameter_code, "stale": STALE_SEC})).fetchone()
    if row is None or row[0] is None:
        return None
    return (float(row[0]), row[1])


def _match_severity(rules: list[dict], max_temp: float):
    """回傳 max_temp 匹配的最高嚴重度 rule（threshold_value <= max_temp 中 threshold 最大者）。

    rules 已按 threshold_value ASC 排序；無匹配回 None。
    對自訂 severity 配置 robust（不假設 severity 與 threshold 順序一致）。
    """
    matched = None
    for r in rules:
        if max_temp >= float(r["threshold_value"]):
            matched = r  # rules ASC → 最後一個符合的即 threshold 最大
        else:
            break
    return matched


async def alarm_evaluator_tick(session_factory: async_sessionmaker) -> None:
    """單次掃描：對每台有 max_temp 的 811C 設備判斷三級閾值，發/解 ems_events。"""
    global _initialized
    async with session_factory() as db:
        if not _initialized:
            await _init_state_from_db(db)
            _initialized = True

        # 讀啟用中的 thermal 閾值規則（all_811c scope），ASC by threshold
        rules = [dict(r) for r in (await db.execute(text("""
            SELECT rule_id, threshold_value, severity, description
            FROM ems_alarm_rule
            WHERE rule_type = 'thermal_temp_exceed'
              AND device_scope = 'all_811c'
              AND enabled = TRUE
            ORDER BY threshold_value ASC
        """))).mappings().all()]

        # 列出近期有回報 max_temp 的 811C 設備（device_scope='all_811c'）
        dev_rows = (await db.execute(text("""
            SELECT DISTINCT device_id FROM trx_reading
            WHERE parameter_code = 'max_temp'
              AND ts > NOW() - make_interval(secs => :stale)
        """), {"stale": STALE_SEC})).fetchall()

        fired = resolved = 0
        for (device_id,) in dev_rows:
            latest = await _latest(db, device_id, "max_temp")
            if latest is None:
                continue
            max_temp, frame_ts = latest

            # ── 自動解除：最高溫 < RESOLVE_BELOW 持續 RESOLVE_WINDOW_SEC ──
            if max_temp < RESOLVE_BELOW:
                if _thermal_state.get(device_id) is not None:
                    if await _all_below_recently(db, device_id):
                        n = await _auto_resolve(db, device_id, max_temp)
                        if n:
                            resolved += 1
                        _thermal_state.pop(device_id, None)
                continue

            # ── 三級閾值匹配 ──
            if not rules:
                continue
            matched = _match_severity(rules, max_temp)
            if matched is None:
                continue
            sev = matched["severity"]
            prev = _thermal_state.get(device_id)

            # 防洗版（D7）：只在「向上跨越」時寫新 event
            if prev is None or _SEV_RANK.get(sev, 0) > _SEV_RANK.get(prev, 0):
                coords = await _latest_coords(db, device_id)
                await _fire_alarm(db, device_id, sev, max_temp,
                                  float(matched["threshold_value"]), coords, frame_ts)
                _thermal_state[device_id] = sev
                fired += 1

        await db.commit()
        if fired or resolved:
            log.info("alarm_evaluator tick: fired=%d resolved=%d", fired, resolved)


async def _all_below_recently(db, device_id: str) -> bool:
    """RESOLVE_WINDOW_SEC 內所有 max_temp 樣本皆 < RESOLVE_BELOW（且至少 1 筆）。"""
    row = (await db.execute(text("""
        SELECT COUNT(*) AS n, COALESCE(MAX(value), 0) AS mx
        FROM trx_reading
        WHERE device_id = :d AND parameter_code = 'max_temp'
          AND ts > NOW() - make_interval(secs => :win)
    """), {"d": device_id, "win": RESOLVE_WINDOW_SEC})).fetchone()
    n, mx = (row[0] or 0), float(row[1] or 0)
    return n >= 1 and mx < RESOLVE_BELOW


async def _latest_coords(db, device_id: str) -> dict:
    """取最新 max_coord_row/col（°C frame 最高溫像素座標 0-7）。"""
    rr = await _latest(db, device_id, "max_coord_row")
    cc = await _latest(db, device_id, "max_coord_col")
    return {
        "x": int(cc[0]) if cc else None,  # col → x
        "y": int(rr[0]) if rr else None,  # row → y
    }


async def _fire_alarm(db, device_id, sev, max_temp, threshold, coords, frame_ts) -> None:
    notify = (sev == "critical")
    msg = f"{device_id} 熱像最高溫 {max_temp:.1f}°C ≥ {threshold:.0f}°C（{sev}）"
    data = {
        "alarm_type": "thermal_temp_exceed",
        "max_temp_c": round(max_temp, 1),
        "threshold_c": threshold,
        "max_temp_coords": coords,
        "frame_timestamp": frame_ts.isoformat() if frame_ts else None,
    }
    await db.execute(text("""
        INSERT INTO ems_events
            (event_kind, severity, source, device_id, actor, message, data_json,
             notify_pananora, notified_at)
        VALUES
            ('thermal_alarm', :sev, 'admin', :device_id, 'alarm_evaluator',
             :msg, CAST(:data AS JSONB),
             :notify, CASE WHEN :notify THEN NOW() ELSE NULL END)
    """), {
        "sev": sev, "device_id": device_id, "msg": msg,
        "data": json.dumps(data, ensure_ascii=False), "notify": notify,
    })
    log.warning("thermal alarm fired: device=%s sev=%s temp=%.1f notify_pananora=%s",
                device_id, sev, max_temp, notify)


async def _auto_resolve(db, device_id, max_temp) -> int:
    """該設備所有未解除 thermal_alarm 填 resolved_at + 寫恢復 info event。回受影響筆數。"""
    res = await db.execute(text("""
        UPDATE ems_events
        SET resolved_at = NOW()
        WHERE event_kind = 'thermal_alarm'
          AND actor = 'alarm_evaluator'
          AND device_id = :d
          AND resolved_at IS NULL
    """), {"d": device_id})
    n = res.rowcount or 0
    if n:
        msg = f"{device_id} 熱像溫度已恢復正常（最高溫 {max_temp:.1f}°C < {RESOLVE_BELOW:.0f}°C 持續 5 分鐘）"
        data = {"alarm_type": "thermal_temp_exceed", "recovered": True,
                "max_temp_c": round(max_temp, 1)}
        await db.execute(text("""
            INSERT INTO ems_events
                (event_kind, severity, source, device_id, actor, message, data_json)
            VALUES
                ('thermal_alarm', 'info', 'admin', :device_id, 'alarm_evaluator',
                 :msg, CAST(:data AS JSONB))
        """), {"device_id": device_id, "msg": msg,
               "data": json.dumps(data, ensure_ascii=False)})
        log.info("thermal alarm auto-resolved: device=%s (%d event(s))", device_id, n)
    return n


async def alarm_evaluator_loop(session_factory: async_sessionmaker) -> None:
    """主 loop：每 TICK_SEC 跑一次；異常不終止 loop。"""
    log.info(
        "alarm_evaluator_loop started (tick=%ss stale=%ss resolve<%s°C×%ss; M-PM-313)",
        TICK_SEC, STALE_SEC, RESOLVE_BELOW, RESOLVE_WINDOW_SEC,
    )
    while True:
        try:
            await alarm_evaluator_tick(session_factory)
        except Exception as e:  # pragma: no cover
            log.exception("alarm_evaluator tick failed: %s", e)
        await asyncio.sleep(TICK_SEC)
