"""Global overload protection (503 mode).

Ported from Oracle PL/SQL ems_ingest_overload.check_overload.
Triggers when inbox backlog or processing lag exceeds thresholds.
Uses hysteresis to prevent oscillation between overloaded/normal states.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

# Thresholds (from Anti-Storm_v1.0 spec)
BACKLOG_TRIGGER = 10000         # inbox NEW count → overloaded
BACKLOG_RELEASE = 8000          # inbox NEW count → release (hysteresis)
LAG_MIN_TRIGGER = 60            # processing lag minutes → overloaded
LAG_MIN_RELEASE = 30            # processing lag minutes → release (hysteresis)
RATE_WINDOW_MIN = 5             # window to measure done_per_min

# Retry-After bounds (seconds)
RETRY_AFTER_MIN = 60
RETRY_AFTER_MAX = 300

# In-memory overload state (simple for single-process uvicorn)
_is_overloaded = False


@dataclass
class OverloadResult:
    is_overloaded: bool
    retry_after_sec: Optional[int] = None
    backlog_count: int = 0
    done_per_min: float = 0
    lag_min: float = 0


async def check_overload(db: AsyncSession) -> OverloadResult:
    """Check global system overload based on inbox backlog and processing lag.

    Returns OverloadResult with retry_after_sec if overloaded.
    """
    global _is_overloaded

    # 1. Count pending backlog
    backlog_result = await db.execute(
        text("""
            SELECT COUNT(*) FROM ems_ingest_inbox
            WHERE process_status = 'NEW'
              AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
        """)
    )
    backlog = backlog_result.scalar() or 0

    # 2. Count processed in last N minutes → done_per_min
    done_result = await db.execute(
        text("""
            SELECT COUNT(*) FROM ems_ingest_inbox
            WHERE process_status = 'DONE'
              AND processed_at >= NOW() - INTERVAL ':window minutes'
        """.replace(":window", str(RATE_WINDOW_MIN)))
    )
    done_count = done_result.scalar() or 0
    done_per_min = done_count / RATE_WINDOW_MIN if RATE_WINDOW_MIN > 0 else 0

    # 3. Estimate lag
    if done_per_min > 0:
        lag_min = backlog / done_per_min
    else:
        # No processed data yet (Worker not running or just started).
        # Only flag lag if backlog is already above trigger threshold;
        # otherwise treat lag as 0 to avoid false overload on startup.
        lag_min = 999999 if backlog > BACKLOG_TRIGGER else 0

    # 4. Overload decision with hysteresis
    if backlog > BACKLOG_TRIGGER or lag_min > LAG_MIN_TRIGGER:
        _is_overloaded = True
    elif backlog < BACKLOG_RELEASE and lag_min < LAG_MIN_RELEASE:
        _is_overloaded = False
    # else: in hysteresis band, keep current state

    # 5. Calculate retry_after
    retry_after = None
    if _is_overloaded:
        if done_per_min <= 0:
            retry_after = RETRY_AFTER_MAX
        else:
            retry_after = int(lag_min * 60)

        retry_after = max(RETRY_AFTER_MIN, min(retry_after, RETRY_AFTER_MAX))

    return OverloadResult(
        is_overloaded=_is_overloaded,
        retry_after_sec=retry_after,
        backlog_count=backlog,
        done_per_min=done_per_min,
        lag_min=lag_min,
    )
