"""IO Overload Cascade Watcher (M-PM-245 §2.3 / §C).

vault SSOT v1.0 §4.5.3 過載 cascade：
  每 5 sec 採證 trx_io_reading DI overload state；偵測到過載 →
    1. 立即 DO OFF（命令派發）
    2. DB log 進 ems_alert_active（複用既建；不新建 trx_io_alarm）
    3. admin-ui WebSocket / polling 通知（M-PM-245 §2.3）
    4. Telegram push（env-gated；M-PM-245 §2.5）

⚠️ 本 module 為 stub 雛形：trx_io_reading ingest pipeline 不存在（M-PM-245 §A 升報 #1）.
本 watcher 未在 main.py lifespan 啟用；P10C 補 ingest 後 P12A 第二輪移除 stub guard 啟用.

啟用 SOP（P10C ingest 完工後）：
  1. 確認 trx_io_reading 表存在 + driver poll DI state 寫入
  2. 在 main.py lifespan 加：
       task = asyncio.create_task(start_overload_watcher())
       yield
       task.cancel()
  3. 觀察 ems_alert_active row + ems_events log
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

from app.constants.io_topology import IO_DEVICE_KINDS

log = logging.getLogger(__name__)


WATCHER_POLL_INTERVAL_SEC = 5.0
WATCHER_ENABLED = False  # M-PM-245 §A 升報 #1 待 P10C 補 trx_io_reading ingest 後改 True


async def detect_overload_once() -> list[dict]:
    """單次掃 trx_io_reading 偵測過載；回 list of overload events.

    TODO（P10C ingest 補完後）:
      1. SELECT device_id, parameter_code(=di_overload_ch{N}), value(=1)
         FROM trx_io_reading
         WHERE ts > NOW() - INTERVAL '10 sec'
           AND device_id 對應 device_kind=tcs300b03_di
           AND value = 1 (overload triggered);
      2. 對每個 overload event 觸發 cascade（DO OFF + alarm row + Telegram push）.

    本 stub 直接回 []（無 ingest 來源；不做事）.
    """
    if not WATCHER_ENABLED:
        return []

    # TODO: implement actual query against trx_io_reading
    return []


async def trigger_cascade(event: dict) -> None:
    """單個過載事件 cascade. event keys: device_id, channel, ts, value.

    TODO（P10C ingest + Edge RelayController 補完後）:
      1. 派 ems_commands command_type='io.do.set' state=False 到對應 DO device + channel
      2. INSERT ems_alert_active row (severity='critical', trigger_metric='overload', ...)
      3. push_telegram_alarm(...)
      4. WebSocket / polling 通知 admin-ui

    本 stub 只寫 log；不執行 cascade（避免 stub state 累積 alarm row）.
    """
    log.warning(
        "[OverloadWatcher STUB] would cascade: device_id=%s channel=%s ts=%s",
        event.get("device_id"), event.get("channel"), event.get("ts"),
    )


async def start_overload_watcher() -> None:
    """asyncio task：每 5 sec 跑一次 detect → cascade.

    啟用條件：WATCHER_ENABLED = True（P10C 補 ingest 後手動切）.
    """
    if not WATCHER_ENABLED:
        log.info(
            "[OverloadWatcher] disabled (WATCHER_ENABLED=False); M-PM-245 §A 升報 #1 "
            "trx_io_reading ingest pipeline 待 P10C 補；補完後改 True 啟用"
        )
        return

    log.info("[OverloadWatcher] starting; poll interval=%.1fs", WATCHER_POLL_INTERVAL_SEC)
    while True:
        try:
            events = await detect_overload_once()
            for event in events:
                await trigger_cascade(event)
        except asyncio.CancelledError:
            log.info("[OverloadWatcher] cancelled; stopping")
            raise
        except Exception as exc:  # pragma: no cover
            log.exception("[OverloadWatcher] iteration failed: %s", exc)
        await asyncio.sleep(WATCHER_POLL_INTERVAL_SEC)


# Convenience: status info for debugging (could be exposed via /v1/admin/io/watcher/status if needed)
def watcher_status() -> dict:
    return {
        "enabled": WATCHER_ENABLED,
        "poll_interval_sec": WATCHER_POLL_INTERVAL_SEC,
        "io_device_kinds": sorted(IO_DEVICE_KINDS),
        "now": datetime.now(timezone.utc).isoformat(),
        "note": "M-PM-245 §A 升報 #1：trx_io_reading ingest 待 P10C 補；補完後 enable",
    }
