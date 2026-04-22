"""Ingest endpoint — POST /ingest/{device_id}

Flexible body parsing: accepts both standard format and Edge v1.1 format.
Logs raw body for debugging during integration phase.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Optional

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_client_ip, get_db, get_edge_fingerprint, verify_bearer_token
from app.middleware.edge_auth import verify_edge_identity
from app.schemas.ingest import IngestRecord, IngestRequest
from app.services import ingest_service, overload_service, rate_limit_service

router = APIRouter()
log = logging.getLogger("ingest")


@router.get("/ingest/latest/{device_id}")
async def get_latest_ingest(
    device_id: str,
    limit: int = 5,
    db: AsyncSession = Depends(get_db),
    _=Depends(verify_bearer_token),
):
    """Return the most recent ingest records for a device."""
    from sqlalchemy import text as sa_text
    result = await db.execute(
        sa_text("""
            SELECT idemp_key, site_id, edge_id, device_id,
                   msg_ts, msg_type, received_at, payload_json
            FROM ems_ingest_inbox
            WHERE device_id = :device_id
            ORDER BY received_at DESC
            LIMIT :limit
        """),
        {"device_id": device_id, "limit": min(limit, 50)},
    )
    columns = result.keys()
    return [dict(zip(columns, row)) for row in result.fetchall()]


@router.get("/ingest/snapshot/{device_id}")
async def get_device_snapshot(
    device_id: str,
    db: AsyncSession = Depends(get_db),
    _=Depends(verify_bearer_token),
):
    """Return latest value per metric for a device (one row per metric)."""
    from sqlalchemy import text as sa_text
    result = await db.execute(
        sa_text("""
            SELECT DISTINCT ON (payload_json->>'metric')
                   payload_json->>'metric' AS metric,
                   payload_json->>'value' AS value,
                   payload_json->>'unit' AS unit,
                   payload_json->>'device_code' AS device_code,
                   received_at
            FROM ems_ingest_inbox
            WHERE device_id = :device_id
              AND payload_json->>'metric' IS NOT NULL
            ORDER BY payload_json->>'metric', received_at DESC
        """),
        {"device_id": device_id},
    )
    columns = result.keys()
    return [dict(zip(columns, row)) for row in result.fetchall()]


@router.post("/ingest/{device_id}", status_code=202)
async def ingest(
    device_id: str,
    request: Request,
    token: str = Depends(verify_bearer_token),
    fingerprint: Optional[str] = Depends(get_edge_fingerprint),
    client_ip: str = Depends(get_client_ip),
    db: AsyncSession = Depends(get_db),
):
    # Parse raw body
    raw = await request.json()
    log.info("INGEST from device=%s ip=%s body=%s", device_id, client_ip, json.dumps(raw, default=str)[:300])

    # Flexible parsing: standard format or raw payload
    if isinstance(raw, dict) and "edge_id" in raw and "records" in raw:
        body = IngestRequest(**raw)
    else:
        edge_id = raw.get("edge_id", "unknown")
        idemp_key = raw.get("idemp_key") or raw.get("idempotency_key") or f"{device_id}-{int(time.time()*1000)}"
        ts_ms = raw.get("ts_ms") or int(time.time() * 1000)
        source_type = raw.get("source_type", "unknown")
        payload = raw.get("payload", raw)
        body = IngestRequest(
            edge_id=edge_id,
            records=[IngestRecord(
                idemp_key=idemp_key,
                ts_ms=ts_ms,
                source_type=source_type,
                payload=payload if isinstance(payload, dict) else {"raw": payload},
                media_ref=raw.get("media_ref"),
            )],
        )

    # 1. Edge three-layer identity (ADR-021)
    auth = await verify_edge_identity(
        db=db, token=token, edge_id=body.edge_id,
        fingerprint=fingerprint, remote_ip=client_ip,
    )
    if not auth.allowed:
        return JSONResponse(
            status_code=auth.status_code,
            content={"status": "forbidden", "detail": auth.error},
        )

    # 2. Global overload check (503)
    overload = await overload_service.check_overload(db)
    if overload.is_overloaded:
        return JSONResponse(
            status_code=503,
            content={"status": "overloaded", "retry_after": overload.retry_after_sec},
            headers={"Retry-After": str(overload.retry_after_sec)},
        )

    # 3. Per-device Token Bucket (429)
    rl = await rate_limit_service.try_consume_token(db, bucket_key=device_id)
    if not rl.allowed:
        return JSONResponse(
            status_code=429,
            content={"status": "rate_limited", "retry_after": rl.retry_after_sec},
            headers={"Retry-After": str(rl.retry_after_sec)},
        )

    # 4. Idempotent inbox insert (202)
    site_id = "tydares"
    await ingest_service.store_records(
        db=db, device_id=device_id, edge_id=body.edge_id, site_id=site_id, records=body.records,
    )

    # 5. WebSocket broadcast
    from app.routers.ws import broadcast
    await broadcast({
        "type": "ingest",
        "device_id": device_id,
        "edge_id": body.edge_id,
        "record_count": len(body.records),
    })

    return JSONResponse(status_code=202, content={"status": "accepted"})
