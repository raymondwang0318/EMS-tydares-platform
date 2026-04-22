"""Command endpoints — matches Edge command_puller.py contract.

Route order matters: /commands/history MUST be before /commands/{edge_id}
to avoid FastAPI treating "history" as an edge_id parameter.

ADR-021: Edge-facing endpoints (poll, status, complete) use three-layer auth.
UI-facing endpoints (create, history) use simple bearer token.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_client_ip, get_db, get_edge_fingerprint, verify_bearer_token
from app.middleware.edge_auth import verify_edge_identity
from app.schemas.command import (
    CommandCreate,
    CommandCreateResponse,
    CommandPollResponse,
    CommandStatusResponse,
    CommandStatusUpdate,
)
from app.services import command_service
from app.services.wakeup_service import send_wakeup
from sqlalchemy import text

router = APIRouter()


# --- History MUST be registered BEFORE {edge_id} to avoid route conflict ---

@router.get("/commands/history")
async def command_history(
    edge_id: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    token: str = Depends(verify_bearer_token),
    db: AsyncSession = Depends(get_db),
):
    commands, total = await command_service.get_history(
        db=db, edge_id=edge_id, status=status, limit=limit, offset=offset
    )
    return {
        "commands": commands,
        "total": total,
        "limit": limit,
        "offset": offset,
    }


# --- Single Command Query (UI polls scan status) — simple token auth ---

@router.get("/commands/detail/{command_id}")
async def get_command(
    command_id: str,
    token: str = Depends(verify_bearer_token),
    db: AsyncSession = Depends(get_db),
):
    cmd = await command_service.get_one(db=db, command_id=command_id)
    if not cmd:
        raise HTTPException(status_code=404, detail="Command not found")
    return cmd


# --- Command Poll (Edge pulls commands) — ADR-021 auth ---

@router.get("/commands/{edge_id}", response_model=CommandPollResponse)
async def poll_commands(
    edge_id: str,
    token: str = Depends(verify_bearer_token),
    fingerprint: Optional[str] = Depends(get_edge_fingerprint),
    client_ip: str = Depends(get_client_ip),
    db: AsyncSession = Depends(get_db),
):
    auth = await verify_edge_identity(
        db=db, token=token, edge_id=edge_id, fingerprint=fingerprint, remote_ip=client_ip,
    )
    if not auth.allowed:
        return JSONResponse(
            status_code=auth.status_code,
            content={"status": "forbidden", "detail": auth.error},
        )

    commands = await command_service.poll_commands(db=db, edge_id=edge_id)
    return {"commands": commands}


# --- Command Status Report (Edge → Central) — ADR-021 auth ---

@router.post("/commands/{command_id}/status", response_model=CommandStatusResponse)
async def report_status(
    command_id: str,
    body: CommandStatusUpdate,
    token: str = Depends(verify_bearer_token),
    fingerprint: Optional[str] = Depends(get_edge_fingerprint),
    client_ip: str = Depends(get_client_ip),
    db: AsyncSession = Depends(get_db),
):
    auth = await verify_edge_identity(
        db=db, token=token, edge_id=body.edge_id, fingerprint=fingerprint, remote_ip=client_ip,
    )
    if not auth.allowed:
        return JSONResponse(
            status_code=auth.status_code,
            content={"status": "forbidden", "detail": auth.error},
        )

    ok = await command_service.update_status(
        db=db, command_id=command_id, status=body.status, edge_id=body.edge_id, result=body.result,
    )
    if not ok:
        raise HTTPException(status_code=404, detail="Command not found")
    return {"status": "ok"}


# --- Command Complete (Edge → Central) — ADR-021 auth ---

@router.post("/commands/{command_id}/complete", response_model=CommandStatusResponse)
async def report_complete(
    command_id: str,
    body: CommandStatusUpdate,
    token: str = Depends(verify_bearer_token),
    fingerprint: Optional[str] = Depends(get_edge_fingerprint),
    client_ip: str = Depends(get_client_ip),
    db: AsyncSession = Depends(get_db),
):
    auth = await verify_edge_identity(
        db=db, token=token, edge_id=body.edge_id, fingerprint=fingerprint, remote_ip=client_ip,
    )
    if not auth.allowed:
        return JSONResponse(
            status_code=auth.status_code,
            content={"status": "forbidden", "detail": auth.error},
        )

    ok = await command_service.update_status(
        db=db, command_id=command_id, status=body.status, edge_id=body.edge_id, result=body.result,
    )
    if not ok:
        raise HTTPException(status_code=404, detail="Command not found")
    return {"status": "ok"}


# --- Command Create (UI → Central) — simple token auth ---

@router.post("/commands", response_model=CommandCreateResponse, status_code=201)
async def create_command(
    body: CommandCreate,
    token: str = Depends(verify_bearer_token),
    db: AsyncSession = Depends(get_db),
):
    command_id = await command_service.create_command(
        db=db,
        device_id=body.device_id,
        command_type=body.command_type,
        payload=body.payload,
        priority=body.priority,
        not_before_ts=body.not_before_ts,
        expire_ts=body.expire_ts,
        idempotency_key=body.idempotency_key,
        issued_by=body.issued_by,
    )

    # 查 device → edge_id，發 MQTT wake-up signal（non-fatal）
    try:
        row = await db.execute(
            text("SELECT edge_id FROM ems_device WHERE device_id = :device_id"),
            {"device_id": body.device_id},
        )
        result = row.fetchone()
        if result:
            send_wakeup(edge_id=result[0])
    except Exception:
        pass  # wake-up 失敗不影響主流程

    return {"command_id": command_id}
