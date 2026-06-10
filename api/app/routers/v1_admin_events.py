"""V2-final Admin 異常履歷 + mail recipient API（M-PM-313 階段2 P2）.

admin 視野：看/管全部 events + 全部 mail 收件人。
- GET    /v1/admin/events                         擴 /v1/reports/events + source/resolved filter + 新 7 欄
- POST   /v1/admin/events/{event_id}/resolve      手動標記已解除（resolved_at=NOW）
- POST   /v1/admin/events/{event_id}/notify-pananora  手動觸發通知 Boss（notify_pananora=TRUE）
- GET/POST/PATCH/DELETE /v1/admin/mail-recipients[/{id}]  mail 收件人 CRUD（無 source filter）

權限：全掛 verify_admin_token（共用 Bearer；M-PM-313 D6）。
Boss 端視野限縮版見 v1_boss.py。
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

import re

from fastapi import APIRouter, Body, Depends, HTTPException, Path, Query
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_db, verify_admin_token
from app.utils.event_humanize import humanize_message

# 輕量 email 格式檢查（不引入 email-validator 依賴；requirements 未含）
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _validate_email(email: str) -> str:
    email = (email or "").strip()
    if not _EMAIL_RE.match(email):
        raise HTTPException(status_code=422, detail=f"invalid email format: {email}")
    return email

router = APIRouter(
    prefix="/v1/admin",
    tags=["admin-events"],
    dependencies=[Depends(verify_admin_token)],
)

VALID_SEVERITY = ("info", "warn", "error", "critical")


# ===== Pydantic =====

class ResolveRequest(BaseModel):
    actor: Optional[str] = Field(None, max_length=64)
    note: Optional[str] = Field(None, max_length=500)


class MailRecipientCreate(BaseModel):
    email: str = Field(..., max_length=255)
    notify_enabled: bool = True
    description: Optional[str] = Field(None, max_length=255)


class MailRecipientUpdate(BaseModel):
    notify_enabled: Optional[bool] = None
    description: Optional[str] = Field(None, max_length=255)


def _event_row(r) -> dict:
    return {
        "event_id": r["event_id"],
        "ts": r["ts"].isoformat() if r["ts"] else None,
        "event_kind": r["event_kind"],
        "severity": r["severity"],
        "source": r["source"],
        "edge_id": r["edge_id"],
        "device_id": r["device_id"],
        "command_id": r["command_id"],
        "actor": r["actor"],
        # M-PM-318+S1 觀察點7（老王 2026-06-10）：出口中文化（DB 保留原文於 message_raw）
        # admin + boss 雙出口共用本函式（v1_boss import _event_row）
        "message": humanize_message(r["message"]),
        "message_raw": r["message"],
        "data_json": r["data_json"],
        "notify_pananora": r["notify_pananora"],
        "notified_at": r["notified_at"].isoformat() if r["notified_at"] else None,
        "resolved_at": r["resolved_at"].isoformat() if r["resolved_at"] else None,
        "mail_sent_at": r["mail_sent_at"].isoformat() if r["mail_sent_at"] else None,
        "mail_send_count": r["mail_send_count"],
    }


# ===== GET /v1/admin/events =====

@router.get("/events")
async def admin_list_events(
    kind: str | None = Query(None),
    severity: str | None = Query(None),
    source: str | None = Query(None, description="'admin' / 'pananora'"),
    edge_id: str | None = Query(None),
    device_id: str | None = Query(None),
    resolved: bool | None = Query(None, description="true=只看已解除 / false=只看未解除"),
    notify_pananora: bool | None = Query(None),
    from_ts: datetime | None = Query(None),
    to_ts: datetime | None = Query(None),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
):
    """admin 看全部 events（含新 7 欄）。filter source/resolved/notify_pananora。"""
    where: list[str] = []
    params: dict = {}
    if kind:
        where.append("event_kind = :kind"); params["kind"] = kind
    if severity:
        where.append("severity = :severity"); params["severity"] = severity
    if source:
        where.append("source = :source"); params["source"] = source
    if edge_id:
        where.append("edge_id = :edge_id"); params["edge_id"] = edge_id
    if device_id:
        where.append("device_id = :device_id"); params["device_id"] = device_id
    if resolved is True:
        where.append("resolved_at IS NOT NULL")
    elif resolved is False:
        where.append("resolved_at IS NULL")
    if notify_pananora is not None:
        where.append("notify_pananora = :np"); params["np"] = notify_pananora
    if from_ts:
        where.append("ts >= :from_ts"); params["from_ts"] = from_ts
    if to_ts:
        where.append("ts < :to_ts"); params["to_ts"] = to_ts
    where_sql = ("WHERE " + " AND ".join(where)) if where else ""

    total = (await db.execute(
        text(f"SELECT COUNT(*) FROM ems_events {where_sql}"), params
    )).scalar_one()

    rows = (await db.execute(text(f"""
        SELECT event_id, ts, event_kind, severity, source, edge_id, device_id,
               command_id, actor, message, data_json,
               notify_pananora, notified_at, resolved_at, mail_sent_at, mail_send_count
        FROM ems_events {where_sql}
        ORDER BY ts DESC
        LIMIT :limit OFFSET :offset
    """), {**params, "limit": limit, "offset": offset})).mappings().all()
    return {"total": total, "items": [_event_row(r) for r in rows]}


# ===== POST /v1/admin/events/{id}/resolve =====

async def _resolve_event(db, event_id: int, actor: str, note: str | None,
                         restrict_boss: bool) -> dict:
    """共用解除邏輯。restrict_boss=True → 只允許解除 boss 視野內事件。"""
    cond = "event_id = :id AND resolved_at IS NULL"
    if restrict_boss:
        cond += " AND (source = 'pananora' OR notify_pananora = TRUE)"
    row = (await db.execute(text(f"""
        UPDATE ems_events SET resolved_at = NOW()
        WHERE {cond}
        RETURNING event_id, device_id, severity
    """), {"id": event_id})).fetchone()
    if row is None:
        # 區分「不存在/無權」與「已解除」
        exists = (await db.execute(
            text("SELECT resolved_at FROM ems_events WHERE event_id = :id LIMIT 1"),
            {"id": event_id})).fetchone()
        if exists is None:
            raise HTTPException(status_code=404, detail=f"event {event_id} not found")
        if exists[0] is not None:
            return {"event_id": event_id, "resolved": True, "message": "already resolved"}
        raise HTTPException(status_code=403, detail="not in scope")
    # 寫一筆審計 info event
    msg = f"事件 #{event_id} 已由 {actor} 手動標記解除" + (f"：{note}" if note else "")
    await db.execute(text("""
        INSERT INTO ems_events (event_kind, severity, source, device_id, actor, message)
        VALUES ('operation', 'info', 'admin', :device_id, :actor, :msg)
    """), {"device_id": row[1], "actor": actor, "msg": msg})
    await db.commit()
    return {"event_id": event_id, "resolved": True, "message": "resolved"}


@router.post("/events/{event_id}/resolve")
async def admin_resolve_event(
    event_id: int = Path(..., ge=1),
    body: ResolveRequest = Body(default=ResolveRequest()),
    db: AsyncSession = Depends(get_db),
):
    return await _resolve_event(db, event_id, body.actor or "admin", body.note, restrict_boss=False)


# ===== POST /v1/admin/events/{id}/notify-pananora =====

@router.post("/events/{event_id}/notify-pananora")
async def admin_notify_pananora(
    event_id: int = Path(..., ge=1),
    db: AsyncSession = Depends(get_db),
):
    """admin 手動讓某事件對 Boss 可見 + 觸發 Mail Worker。"""
    row = (await db.execute(text("""
        UPDATE ems_events
        SET notify_pananora = TRUE,
            notified_at = COALESCE(notified_at, NOW())
        WHERE event_id = :id
        RETURNING event_id
    """), {"id": event_id})).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail=f"event {event_id} not found")
    await db.commit()
    return {"event_id": event_id, "notify_pananora": True}


# ===== mail recipients (admin: 全部) =====

def _recip_row(r) -> dict:
    return {
        "recipient_id": r["recipient_id"],
        "email": r["email"],
        "source": r["source"],
        "notify_enabled": r["notify_enabled"],
        "description": r["description"],
        "created_at": r["created_at"].isoformat() if r["created_at"] else None,
        "created_by": r["created_by"],
    }


@router.get("/mail-recipients")
async def admin_list_recipients(
    source: str | None = Query(None),
    db: AsyncSession = Depends(get_db),
):
    sql = """SELECT recipient_id, email, source, notify_enabled, description,
                    created_at, created_by FROM ems_mail_recipient"""
    params: dict = {}
    if source:
        sql += " WHERE source = :source"; params["source"] = source
    sql += " ORDER BY recipient_id"
    rows = (await db.execute(text(sql), params)).mappings().all()
    return [_recip_row(r) for r in rows]


@router.post("/mail-recipients")
async def admin_create_recipient(
    body: MailRecipientCreate = Body(...),
    db: AsyncSession = Depends(get_db),
):
    email = _validate_email(body.email)
    try:
        row = (await db.execute(text("""
            INSERT INTO ems_mail_recipient (email, source, notify_enabled, description, created_by)
            VALUES (:email, 'admin', :enabled, :desc, 'admin')
            RETURNING recipient_id, email, source, notify_enabled, description, created_at, created_by
        """), {"email": email, "enabled": body.notify_enabled,
               "desc": body.description})).mappings().fetchone()
    except Exception as e:
        if "unique" in str(e).lower() or "duplicate" in str(e).lower():
            raise HTTPException(status_code=409, detail=f"email already exists: {body.email}")
        raise
    await db.commit()
    return _recip_row(row)


@router.patch("/mail-recipients/{recipient_id}")
async def admin_update_recipient(
    recipient_id: int = Path(..., ge=1),
    body: MailRecipientUpdate = Body(...),
    db: AsyncSession = Depends(get_db),
):
    sets: list[str] = []
    params: dict = {"id": recipient_id}
    if body.notify_enabled is not None:
        sets.append("notify_enabled = :enabled"); params["enabled"] = body.notify_enabled
    if body.description is not None:
        sets.append("description = :desc"); params["desc"] = body.description
    if not sets:
        raise HTTPException(status_code=422, detail="no fields to update")
    row = (await db.execute(text(f"""
        UPDATE ems_mail_recipient SET {", ".join(sets)}
        WHERE recipient_id = :id
        RETURNING recipient_id, email, source, notify_enabled, description, created_at, created_by
    """), params)).mappings().fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail=f"recipient {recipient_id} not found")
    await db.commit()
    return _recip_row(row)


@router.delete("/mail-recipients/{recipient_id}")
async def admin_delete_recipient(
    recipient_id: int = Path(..., ge=1),
    db: AsyncSession = Depends(get_db),
):
    res = await db.execute(
        text("DELETE FROM ems_mail_recipient WHERE recipient_id = :id"),
        {"id": recipient_id})
    if (res.rowcount or 0) == 0:
        raise HTTPException(status_code=404, detail=f"recipient {recipient_id} not found")
    await db.commit()
    return {"deleted": recipient_id}
