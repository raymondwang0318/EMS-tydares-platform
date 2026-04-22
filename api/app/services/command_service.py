"""V2-final Command Service (ADR-026).

合併 status + complete 成單一 report endpoint（DR-026）。
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import EmsCommand, EmsEvent


async def create_command(
    db: AsyncSession,
    edge_id: str,
    device_id: str | None,
    command_type: str,
    payload: dict,
    priority: int,
    idempotency_key: str | None,
    issued_by: str | None,
    not_before_ts: datetime | None = None,
    expire_ts: datetime | None = None,
) -> str:
    """UI 建立指令。"""
    if idempotency_key:
        existing = await db.execute(
            select(EmsCommand).where(EmsCommand.idempotency_key == idempotency_key)
        )
        found = existing.scalar_one_or_none()
        if found:
            return found.command_id

    command_id = f"cmd-{uuid.uuid4()}"
    cmd = EmsCommand(
        command_id=command_id,
        edge_id=edge_id,
        device_id=device_id,
        command_type=command_type,
        payload_json=payload,
        status="QUEUED",
        priority=priority,
        idempotency_key=idempotency_key,
        issued_by=issued_by,
        not_before_ts=not_before_ts,
        expire_ts=expire_ts,
    )
    db.add(cmd)
    db.add(EmsEvent(
        event_kind="command",
        severity="info",
        edge_id=edge_id,
        device_id=device_id,
        command_id=command_id,
        actor=issued_by,
        message=f"command created: {command_type}",
        data_json={"payload": payload},
    ))
    await db.commit()
    return command_id


async def poll_commands(db: AsyncSession, edge_id: str, limit: int = 10) -> list[dict]:
    """Edge 拉取 QUEUED 指令，原子改為 DELIVERED。"""
    result = await db.execute(
        text("""
            UPDATE ems_commands
            SET status = 'DELIVERED', updated_at = NOW()
            WHERE command_id IN (
                SELECT command_id FROM ems_commands
                WHERE edge_id = :edge_id
                  AND status = 'QUEUED'
                  AND (not_before_ts IS NULL OR not_before_ts <= NOW())
                  AND (expire_ts IS NULL OR expire_ts > NOW())
                ORDER BY priority DESC, created_at ASC
                FOR UPDATE SKIP LOCKED
                LIMIT :limit
            )
            RETURNING command_id, command_type, payload_json
        """),
        {"edge_id": edge_id, "limit": limit},
    )
    rows = result.fetchall()

    for row in rows:
        db.add(EmsEvent(
            event_kind="command",
            severity="info",
            edge_id=edge_id,
            command_id=row[0],
            message="delivered to edge",
        ))
    await db.commit()

    return [
        {"id": row[0], "command_type": row[1], "payload_json": row[2] or {}}
        for row in rows
    ]


VALID_TERMINAL = {"SUCCEEDED", "FAILED"}
VALID_INTERIM = {"RUNNING"}


async def report_command(
    db: AsyncSession,
    command_id: str,
    edge_id: str,
    status: str,
    terminal: bool,
    result: dict | None,
    error: str | None,
) -> bool:
    """Edge 回報指令執行狀態（合併 status + complete）。"""
    status_up = status.upper()
    if terminal and status_up not in VALID_TERMINAL:
        return False
    if not terminal and status_up not in VALID_INTERIM:
        return False

    cmd_result = await db.execute(
        select(EmsCommand).where(EmsCommand.command_id == command_id)
    )
    cmd = cmd_result.scalar_one_or_none()
    if cmd is None or cmd.edge_id != edge_id:
        return False

    cmd.status = status_up
    if terminal:
        cmd.result_json = result or {}

    severity = "info" if status_up == "SUCCEEDED" else (
        "warn" if status_up == "RUNNING" else "error"
    )
    db.add(EmsEvent(
        event_kind="command",
        severity=severity,
        edge_id=edge_id,
        device_id=cmd.device_id,
        command_id=command_id,
        message=f"report: {status_up}" + (f" err={error}" if error else ""),
        data_json={"result": result, "error": error},
    ))
    await db.commit()
    return True
