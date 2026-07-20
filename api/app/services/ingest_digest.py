"""M-PM-345 雙 channel ingest 消化率計算（P12A §六配套）.

讀 ems_ingest_inbox 按 channel 統計（A 即時 / B 歷史補 / NULL 單軌 legacy）：
  backlog      = 未處理（processed_at IS NULL AND error_message IS NULL；對齊 worker process_batch 撈取條件）
  done_window  = 近 window_min 分鐘已處理（processed_at >= NOW()-window）
  rate_per_min = done_window / window_min
  lag_sec      = backlog / rate_per_sec（rate=0 且有 backlog → None 表示消化停滯）

inbox 受 worker 每 5 分鐘 cleanup（清已處理 >1h）控制大小，GROUP BY channel 全表 OK
（inbox 為小緩衝表，非 trx_reading 大表，無需時間窗）。endpoint 與 watcher 共用此計算。

⚠️ 不復活死碼 overload_service/rate_limit_service（查不存在的 process_status/ems_rate_limit_bucket）；
本函式改查活躍 v2-final schema（processed_at IS NULL=NEW）。
"""
from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


async def compute_digest_rate(db: AsyncSession, window_min: int = 5) -> list[dict]:
    """回各 channel 的消化率 dict 清單（channel='A'/'B'/None）。"""
    rows = (await db.execute(
        text("""
            SELECT
              channel,
              COUNT(*) FILTER (
                  WHERE processed_at IS NULL AND error_message IS NULL
              ) AS backlog,
              COUNT(*) FILTER (
                  WHERE processed_at IS NOT NULL
                    AND processed_at >= NOW() - make_interval(mins => :w)
              ) AS done_window
            FROM ems_ingest_inbox
            GROUP BY channel
            ORDER BY channel NULLS FIRST
        """),
        {"w": window_min},
    )).mappings().all()

    out: list[dict] = []
    for r in rows:
        backlog = r["backlog"] or 0
        done = r["done_window"] or 0
        rate_per_min = done / window_min if window_min > 0 else 0.0
        rate_per_sec = rate_per_min / 60.0
        # rate=0 但有 backlog → 消化停滯（lag 無限大）；以 None 表示，呼叫端判讀
        lag_sec = int(backlog / rate_per_sec) if rate_per_sec > 0 else (None if backlog > 0 else 0)
        out.append({
            "channel": (r["channel"] or None),   # CHAR(1) 'A'/'B'，NULL→None
            "backlog": backlog,
            "done_window": done,
            "rate_per_min": round(rate_per_min, 1),
            "lag_sec": lag_sec,
        })
    return out
