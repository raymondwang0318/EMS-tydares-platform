"""Per-device Token Bucket rate limiter.

Ported from Oracle PL/SQL ems_ingest_rate_limit.try_consume_token.
Uses atomic UPDATE with RETURNING — no SELECT-before-UPDATE.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

# Retry-After bounds (seconds)
RETRY_AFTER_MIN = 5
RETRY_AFTER_MAX = 300

# Default bucket config for new devices
DEFAULT_CAPACITY = 100
DEFAULT_REFILL_PER_SEC = 1.0


@dataclass
class RateLimitResult:
    allowed: bool
    retry_after_sec: Optional[int] = None


async def try_consume_token(
    db: AsyncSession, bucket_key: str, cost: int = 1
) -> RateLimitResult:
    """Attempt to consume token(s) from a device's bucket.

    Atomic: refill + deduct in a single UPDATE. No race conditions.
    Returns RateLimitResult with allowed=True or retry_after_sec.
    """

    # Atomic refill + deduct (single UPDATE, matching Oracle pattern)
    result = await db.execute(
        text("""
            UPDATE ems_rate_limit_bucket
            SET
                tokens = LEAST(
                    capacity,
                    tokens + FLOOR(EXTRACT(EPOCH FROM (NOW() - last_refill_at))) * refill_per_sec
                ) - :cost,
                last_refill_at = NOW()
            WHERE
                bucket_key = :bucket_key
                AND LEAST(
                    capacity,
                    tokens + FLOOR(EXTRACT(EPOCH FROM (NOW() - last_refill_at))) * refill_per_sec
                ) >= :cost
            RETURNING tokens
        """),
        {"bucket_key": bucket_key, "cost": cost},
    )
    row = result.fetchone()

    if row is not None:
        return RateLimitResult(allowed=True)

    # Token insufficient — calculate retry_after
    info = await db.execute(
        text("""
            SELECT tokens, capacity, refill_per_sec
            FROM ems_rate_limit_bucket
            WHERE bucket_key = :bucket_key
        """),
        {"bucket_key": bucket_key},
    )
    bucket = info.fetchone()

    if bucket is None:
        # No bucket exists — auto-create with defaults (first time device)
        await db.execute(
            text("""
                INSERT INTO ems_rate_limit_bucket
                    (bucket_key, tokens, capacity, refill_per_sec)
                VALUES
                    (:bucket_key, :capacity, :capacity, :refill_per_sec)
                ON CONFLICT (bucket_key) DO NOTHING
            """),
            {
                "bucket_key": bucket_key,
                "capacity": DEFAULT_CAPACITY,
                "refill_per_sec": DEFAULT_REFILL_PER_SEC,
            },
        )
        await db.commit()
        # First request for new device — allow it
        return RateLimitResult(allowed=True)

    tokens, capacity, refill_per_sec = bucket[0], bucket[1], bucket[2]

    if refill_per_sec <= 0:
        retry_after = RETRY_AFTER_MAX
    else:
        retry_after = int((cost - max(tokens, 0)) / refill_per_sec) + 1

    retry_after = max(RETRY_AFTER_MIN, min(retry_after, RETRY_AFTER_MAX))

    return RateLimitResult(allowed=False, retry_after_sec=retry_after)
