"""V2-final Admin Ingest 維運 endpoint（M-PM-345 §六 P12A 雙 channel 配套）.

唯讀消化率查詢；掛 verify_admin_token（viewer 唯讀帳號亦可讀 — 維運資訊）。
  GET /v1/admin/ingest/digest-rate  inbox A/B channel 消化率（backlog/rate/lag）
"""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_db, verify_admin_token
from app.services.ingest_digest import compute_digest_rate

router = APIRouter(
    prefix="/v1/admin", tags=["admin-ingest"],
    dependencies=[Depends(verify_admin_token)],
)


@router.get("/ingest/digest-rate")
async def ingest_digest_rate(
    window_min: int = Query(5, ge=1, le=60),
    db: AsyncSession = Depends(get_db),
):
    """ingest inbox 雙 channel 消化率（M-PM-345 §六 P12A 配套）.

    channel：A(即時)/B(歷史補)/null(單軌 legacy)。
    backlog=未處理；done_window=近 window_min 已處理；
    rate_per_min=處理速率；lag_sec=backlog/rate（null=有 backlog 但速率 0=消化停滯）。
    """
    channels = await compute_digest_rate(db, window_min)
    return {
        "ts": datetime.now(timezone.utc).isoformat(),
        "window_min": window_min,
        "channels": channels,
    }
