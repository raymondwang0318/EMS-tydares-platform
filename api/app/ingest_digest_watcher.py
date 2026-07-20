"""雙 channel ingest 消化率 watcher（M-PM-345 §六 P12A 配套）.

⚠️ Phase 1 OBSERVE-ONLY：定期算 A/B/NULL 消化率寫 log 觀察；**不發告警**。
告警觸發閾值（Channel B lag_sec / backlog 深度 / 持續輪數）待 PM/業主拍板
（M-P12-139 §四升報）。閾值定後啟用 _fire/_resolve —— 複製 io_anomaly_watcher pattern：
in-memory state 防洗版 + GRACE + 自動解除 + 寫 ems_events(notify_pananora=TRUE) → mail_worker 既建管道。

設計取捨（採證 M-PM-345）：
- Channel A（即時）斷流已由既建 ECSU lag（v1_admin_fleet）+ alert_evaluator edge 健康覆蓋 → 本 watcher 專注 Channel B 積壓。
- 全 fleet 上 wire 前（目前僅 E18 雙 channel）多數 channel=NULL（單軌），observe-only 階段先累積基線。

部署：ems-worker 單實例 asyncio task（同 io_anomaly_watcher / alarm_evaluator pattern；多 worker 待轉 Redis state）。
"""
from __future__ import annotations

import asyncio
import logging

from sqlalchemy.ext.asyncio import async_sessionmaker

from app.services.ingest_digest import compute_digest_rate

log = logging.getLogger("ingest_digest_watcher")

TICK_SEC = 60.0          # 掃描週期（消化率粒度；對齊 ingest 5min window，不需太密）
DIGEST_WINDOW_MIN = 5    # 消化率統計窗（與 compute_digest_rate 預設一致）

# ── TODO(PM/業主拍板) 告警閾值佔位（OBSERVE-ONLY 階段不觸發）──────────────
# 啟用時複製 io_anomaly_watcher pattern：_state 防洗版 + GRACE 持續 + _fire/_resolve 自動解除。
# B_LAG_TRIGGER_SEC = ???    # Channel B lag_sec 超此值持續 GRACE → 告警
# B_BACKLOG_TRIGGER = ???    # Channel B backlog 深度上限
# GRACE_SEC = ???            # 連續超標多久才 fire（防瞬時抖動）
# _state: dict[str, dict] = {}   # in-memory 防洗版 state（待啟用）


async def ingest_digest_tick(session_factory: async_sessionmaker) -> None:
    """單次：算各 channel 消化率，OBSERVE-ONLY log（閾值定後加 _fire/_resolve）。"""
    async with session_factory() as db:
        channels = await compute_digest_rate(db, window_min=DIGEST_WINDOW_MIN)

    summary = "; ".join(
        f"{(c['channel'] or 'NULL')}: backlog={c['backlog']} "
        f"rate={c['rate_per_min']}/min lag={c['lag_sec']}s"
        for c in channels
    ) or "(no inbox rows)"
    log.info("ingest digest [observe-only]: %s", summary)

    # TODO(PM 閾值)：Channel B lag/backlog 超閾值持續 GRACE → _fire
    #   寫 ems_events(event_kind='operation', actor='ingest_digest_watcher',
    #                 source='ingest', notify_pananora=TRUE)
    #   恢復 → _resolve（UPDATE resolved_at；對齊 alarm_evaluator 自動解除，
    #   避免既建非 thermal 事件 resolved_at 不自動填的坑）。


async def ingest_digest_watcher_loop(session_factory: async_sessionmaker) -> None:
    """主 loop：每 TICK_SEC 跑一次；異常不終止 loop。"""
    log.info(
        "ingest_digest_watcher_loop started (tick=%ss; OBSERVE-ONLY 待 PM 閾值; M-PM-345 §六)",
        TICK_SEC,
    )
    while True:
        try:
            await ingest_digest_tick(session_factory)
        except Exception as e:  # pragma: no cover
            log.exception("ingest_digest tick failed: %s", e)
        await asyncio.sleep(TICK_SEC)
