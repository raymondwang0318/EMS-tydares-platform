"""Edge 心跳看門狗（M-PM-358 Phase 1，老王 2026-07-13 拍板）.

整台 edge 失聯偵測：30 小時（止血層天花板）→ 分鐘級。

  每 EDGE_HB_TICK_SEC 掃 ems_edge_heartbeat 各 edge 最後心跳；
  gap > EDGE_HB_ALERT_SEC（預設 600s=10 分鐘，心跳 60s 一次漏 10 次才告警）
    → 開 ems_events 事件單（data_json.kind='edge_outage'，source='central_heartbeat'）
    → 發信完全複用 mail_worker 既有機制（edge_outage 4 人組分流 + 降頻 0/24h + 恢復通知對稱）。
  心跳回來 → 自動 resolve 自己開的單 → mail_worker 發「✅ 已恢復」。

去重（M-P11-E122 介面 + M-PM-358 §3.2 初始化保護）：
  開單前查同 edge 任何 source 的 active kind='edge_outage' event → 有則跳過不開
  （涵蓋止血層 pananora 開的單，如上線時 E09/E16 的 4951/4952）。
  resolve 只動自己（source='central_heartbeat'）的單；止血層的單由止血層自己 resolve
  （其 pn_edge_outage_state.event_id 指向該單，代關會弄壞其狀態機）。

老王 2026-07-13 同步拍板：告警信件內容模式維持現狀（message 白話對齊 E116 風格）。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from datetime import timedelta, timezone

from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker

log = logging.getLogger("edge_hb_watcher")

TICK_SEC = float(os.getenv("EDGE_HB_TICK_SEC", "60"))
ALERT_SEC = float(os.getenv("EDGE_HB_ALERT_SEC", "600"))  # 10 分鐘（老王拍板）
TW_TZ = timezone(timedelta(hours=8))

# 記憶已 log 過的失聯 edge（只在狀態轉變時 log/動作，避免每 tick 洗版；重啟丟失無妨，
# 重新判定時開單去重查詢會擋重複）
_known_down: set[str] = set()


def _fmt_tw(ts) -> str:
    try:
        return ts.astimezone(TW_TZ).strftime("%m-%d %H:%M")
    except (ValueError, AttributeError):
        return "-"


async def _affected_circuits(db, edge_id: str) -> list[str]:
    """該 edge 影響的 KW 迴路清單（Central 端 fnd_ecsu 綁定）。"""
    rows = (await db.execute(text("""
        SELECT DISTINCT e.ecsu_id, COALESCE(e.ecsu_name, '') AS name
        FROM fnd_ecsu e
        JOIN fnd_ecsu_circuit_assgn a ON a.ecsu_id = e.ecsu_id
        JOIN ems_device d ON d.device_id = a.device_id
        WHERE d.edge_id = :eid AND d.deleted_at IS NULL
        ORDER BY 1
    """), {"eid": edge_id})).all()
    return [f"KW-{r[0]} {r[1]}".strip() for r in rows]


async def _open_outage_event(db, edge_id: str, last_hb, gap_min: int) -> None:
    """開失聯事件單（去重：同 edge 任何 source 的 active edge_outage 存在則跳過）。"""
    dup = (await db.execute(text("""
        SELECT event_id, source FROM ems_events
        WHERE data_json->>'kind' = 'edge_outage'
          AND data_json->>'edge_id' = :eid
          AND resolved_at IS NULL
        LIMIT 1
    """), {"eid": edge_id})).first()
    if dup:
        log.info("edge_hb_watcher: %s 失聯（gap %d 分）但已有 active event #%s（source=%s）→ 去重跳過",
                 edge_id, gap_min, dup[0], dup[1])
        return

    circuits = await _affected_circuits(db, edge_id)
    cpu_temp = (await db.execute(text("""
        SELECT payload_json->>'cpu_temp_c' FROM ems_edge_heartbeat
        WHERE edge_id = :eid ORDER BY hb_ts DESC LIMIT 1
    """), {"eid": edge_id})).scalar()

    head = "、".join(circuits[:6]) + ("…" if len(circuits) > 6 else "")
    temp_s = f"，最後核心溫度 {cpu_temp}°C" if cpu_temp else ""
    message = (f"🔌 {edge_id} 通訊中斷（心跳逾 {int(ALERT_SEC // 60)} 分鐘）"
               f"— 該區 {len(circuits)} 個迴路受影響（{head}），"
               f"最後心跳 {_fmt_tw(last_hb)}{temp_s}，請檢查該區網路（光纖/交換器）與 Edge 設備供電")
    data = {"kind": "edge_outage", "edge_id": edge_id, "circuits": circuits,
            "last_hb": _fmt_tw(last_hb), "cpu_temp_c": cpu_temp, "gap_min": gap_min}

    await db.execute(text("""
        INSERT INTO ems_events (ts, event_kind, severity, edge_id, message, data_json,
                                source, notify_pananora)
        VALUES (NOW(), 'operation', 'critical', :eid, :msg, CAST(:dj AS jsonb),
                'central_heartbeat', TRUE)
    """), {"eid": edge_id, "msg": message, "dj": json.dumps(data, ensure_ascii=False)})
    await db.commit()
    log.warning("edge_hb_watcher: %s 失聯告警開單（gap %d 分，%d 迴路）→ mail_worker 下 tick 發信",
                edge_id, gap_min, len(circuits))


async def _resolve_own_events(db, edge_id: str) -> None:
    """心跳恢復 → resolve 自己開的單（止血層的單由止血層自己收）。"""
    res = await db.execute(text("""
        UPDATE ems_events
        SET resolved_at = NOW(),
            message = message || '（✅ 心跳已恢復）'
        WHERE source = 'central_heartbeat'
          AND data_json->>'kind' = 'edge_outage'
          AND data_json->>'edge_id' = :eid
          AND resolved_at IS NULL
    """), {"eid": edge_id})
    if res.rowcount:
        await db.commit()
        log.warning("edge_hb_watcher: %s 心跳恢復 → resolve %d 筆 → mail_worker 發恢復信",
                    edge_id, res.rowcount)


async def edge_hb_watcher_tick(session_factory: async_sessionmaker) -> None:
    async with session_factory() as db:
        rows = (await db.execute(text("""
            SELECT edge_id, max(hb_ts) AS last_hb,
                   EXTRACT(EPOCH FROM (NOW() - max(hb_ts))) AS gap_sec
            FROM ems_edge_heartbeat
            GROUP BY edge_id
        """))).all()

        for edge_id, last_hb, gap_sec in rows:
            if gap_sec > ALERT_SEC:
                if edge_id not in _known_down:
                    _known_down.add(edge_id)
                    await _open_outage_event(db, edge_id, last_hb, int(gap_sec // 60))
            else:
                if edge_id in _known_down:
                    _known_down.discard(edge_id)
                    await _resolve_own_events(db, edge_id)


async def edge_hb_watcher_loop(session_factory: async_sessionmaker) -> None:
    if os.getenv("EDGE_HB_WATCHER", "1") != "1":
        log.info("edge_hb_watcher disabled（EDGE_HB_WATCHER!=1）")
        return
    log.info("edge_hb_watcher_loop started (tick=%ss alert_gap=%ss; M-PM-358 Phase 1)",
             TICK_SEC, ALERT_SEC)
    # 啟動先掃一輪建立 _known_down 基線（含去重查詢，上線時 E09/E16 已有止血層單 → 跳過不重發）
    while True:
        try:
            await edge_hb_watcher_tick(session_factory)
        except Exception as e:  # pragma: no cover — DB 短暫不可用等，下輪重試不誤開單
            log.exception("edge_hb_watcher tick failed: %s", e)
        await asyncio.sleep(TICK_SEC)
