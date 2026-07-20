"""V2-final Ingest Service (ADR-026 DR-026-01).

Inbox 為冪等緩衝（1 小時），不是 SSOT。Worker 之後展平到 trx_reading。
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.schemas.ingest import IngestRecord


async def store_records(
    db: AsyncSession,
    edge_id: str,
    device_id: str,
    records: list[IngestRecord],
    channel: str | None = None,
) -> tuple[int, int]:
    """寫入 inbox，冪等 ON CONFLICT DO NOTHING。

    回傳 (accepted, duplicated)。

    channel（M-PM-345 雙 channel）：'A'(即時)/'B'(歷史補)/None(legacy 單軌)；
    透傳入 ems_ingest_inbox.channel 供 Central 分別記 A/B 消化率（§六 P12A 配套）。
    向後相容：channel=None 時欄位寫 NULL，不影響既有單軌 fleet。
    """
    accepted = 0
    duplicated = 0
    for rec in records:
        msg_ts = datetime.fromtimestamp(rec.ts_ms / 1000.0, tz=timezone.utc)

        dev_id = device_id
        if rec.payload and isinstance(rec.payload.get("device_id"), str):
            dev_id = rec.payload["device_id"]

        result = await db.execute(
            text("""
                INSERT INTO ems_ingest_inbox
                    (idemp_key, edge_id, device_id, source_type, msg_ts, payload_json, channel)
                VALUES
                    (:idemp_key, :edge_id, :device_id, :source_type, :msg_ts,
                     CAST(:payload_json AS JSONB), :channel)
                ON CONFLICT (idemp_key) DO NOTHING
            """),
            {
                "idemp_key": rec.idemp_key,
                "edge_id": edge_id,
                "device_id": dev_id,
                "source_type": rec.source_type,
                "msg_ts": msg_ts,
                "payload_json": json.dumps(rec.payload),
                "channel": channel,
            },
        )
        if (result.rowcount or 0) > 0:
            accepted += 1
        else:
            duplicated += 1
    await db.commit()
    return accepted, duplicated
