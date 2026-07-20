"""V2-final Boss(Pananora 前台) 異常履歷 + mail recipient API（M-PM-313 階段2 P2）.

Boss 視野限縮：只看/管「與 Boss 相關」的事件與收件人。
- GET  /v1/boss/events                      WHERE source='pananora' OR notify_pananora=TRUE
- POST /v1/boss/events                       Boss 電力自判後上報（強制 source='pananora'）
- POST /v1/boss/events/{event_id}/resolve    手動解除（限 boss 視野內事件）
- GET/POST/PATCH/DELETE /v1/boss/mail-recipients[/{id}]  限 source='pananora'

權限：共用 verify_admin_token（Boss 與 admin 同一支 Bearer；採證 Pananora 對接 v2.1）。
電流數據 Boss 端另呼叫既建 /v1/admin/ecsu/{ecsu_id}/realtime（不在本 router）。
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Path, Query
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_db, verify_admin_token
from app.routers.v1_admin_events import (
    ResolveRequest,
    _event_row,
    _recip_row,
    _resolve_event,
    _validate_email,
)

router = APIRouter(
    prefix="/v1/boss",
    tags=["boss"],
    dependencies=[Depends(verify_admin_token)],
)

VALID_SEVERITY = ("info", "warn", "error", "critical")
VALID_EVENT_KIND = ("command", "operation", "comm_abn", "edge_lifecycle", "config_sync", "thermal_alarm")

# Boss 視野條件（與 GET / resolve 一致）
BOSS_SCOPE = "(source = 'pananora' OR notify_pananora = TRUE)"


class BossEventCreate(BaseModel):
    severity: str = Field("warn")
    message: str = Field(..., max_length=2000)
    event_kind: str = Field("operation")
    device_id: Optional[str] = Field(None, max_length=64)
    edge_id: Optional[str] = Field(None, max_length=64)
    actor: Optional[str] = Field("pananora", max_length=128)
    notify_pananora: bool = True
    data_json: Optional[dict] = None


class BossMailRecipientCreate(BaseModel):
    email: str = Field(..., max_length=255)
    notify_enabled: bool = True
    description: Optional[str] = Field(None, max_length=255)


class MailRecipientUpdate(BaseModel):
    notify_enabled: Optional[bool] = None
    description: Optional[str] = Field(None, max_length=255)


# ===== GET /v1/boss/events =====

@router.get("/events")
async def boss_list_events(
    severity: str | None = Query(None),
    device_id: str | None = Query(None),
    resolved: bool | None = Query(None),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
):
    """Boss 只看 source='pananora' 或 notify_pananora=TRUE 的事件。"""
    where = [BOSS_SCOPE]
    params: dict = {}
    if severity:
        where.append("severity = :severity"); params["severity"] = severity
    if device_id:
        where.append("device_id = :device_id"); params["device_id"] = device_id
    if resolved is True:
        where.append("resolved_at IS NOT NULL")
    elif resolved is False:
        where.append("resolved_at IS NULL")
    where_sql = "WHERE " + " AND ".join(where)

    total = (await db.execute(
        text(f"SELECT COUNT(*) FROM ems_events {where_sql}"), params)).scalar_one()
    rows = (await db.execute(text(f"""
        SELECT event_id, ts, event_kind, severity, source, edge_id, device_id,
               command_id, actor, message, data_json,
               notify_pananora, notified_at, resolved_at, mail_sent_at, mail_send_count
        FROM ems_events {where_sql}
        ORDER BY ts DESC
        LIMIT :limit OFFSET :offset
    """), {**params, "limit": limit, "offset": offset})).mappings().all()
    return {"total": total, "items": [_event_row(r) for r in rows]}


# ===== POST /v1/boss/events =====

@router.post("/events")
async def boss_create_event(
    body: BossEventCreate = Body(...),
    db: AsyncSession = Depends(get_db),
):
    """Boss 電力異常自判後上報；強制 source='pananora'。"""
    if body.severity not in VALID_SEVERITY:
        raise HTTPException(status_code=422, detail=f"severity must be one of: {VALID_SEVERITY}")
    if body.event_kind not in VALID_EVENT_KIND:
        raise HTTPException(status_code=422, detail=f"event_kind must be one of: {VALID_EVENT_KIND}")
    import json as _json
    row = (await db.execute(text("""
        INSERT INTO ems_events
            (event_kind, severity, source, edge_id, device_id, actor, message, data_json,
             notify_pananora, notified_at)
        VALUES
            (:kind, :sev, 'pananora', :edge_id, :device_id, :actor, :msg,
             CAST(:data AS JSONB), :notify, CASE WHEN :notify THEN NOW() ELSE NULL END)
        RETURNING event_id, ts
    """), {
        "kind": body.event_kind, "sev": body.severity, "edge_id": body.edge_id,
        "device_id": body.device_id, "actor": body.actor or "pananora", "msg": body.message,
        "data": _json.dumps(body.data_json, ensure_ascii=False) if body.data_json is not None else None,
        "notify": body.notify_pananora,
    })).fetchone()
    await db.commit()
    return {"event_id": row[0], "ts": row[1].isoformat() if row[1] else None, "source": "pananora"}


# ===== POST /v1/boss/events/{id}/resolve =====

@router.post("/events/{event_id}/resolve")
async def boss_resolve_event(
    event_id: int = Path(..., ge=1),
    body: ResolveRequest = Body(default=ResolveRequest()),
    db: AsyncSession = Depends(get_db),
):
    return await _resolve_event(db, event_id, body.actor or "pananora", body.note, restrict_boss=True)


# ===== mail recipients (boss: 限 source='pananora') =====

@router.get("/mail-recipients")
async def boss_list_recipients(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(text("""
        SELECT recipient_id, email, source, notify_enabled, description, created_at, created_by
        FROM ems_mail_recipient WHERE source = 'pananora' ORDER BY recipient_id
    """))).mappings().all()
    return [_recip_row(r) for r in rows]


@router.post("/mail-recipients")
async def boss_create_recipient(
    body: BossMailRecipientCreate = Body(...),
    db: AsyncSession = Depends(get_db),
):
    email = _validate_email(body.email)
    try:
        row = (await db.execute(text("""
            INSERT INTO ems_mail_recipient (email, source, notify_enabled, description, created_by)
            VALUES (:email, 'pananora', :enabled, :desc, 'pananora')
            RETURNING recipient_id, email, source, notify_enabled, description, created_at, created_by
        """), {"email": email, "enabled": body.notify_enabled, "desc": body.description})).mappings().fetchone()
    except Exception as e:
        if "unique" in str(e).lower() or "duplicate" in str(e).lower():
            raise HTTPException(status_code=409, detail=f"email already exists: {email}")
        raise
    await db.commit()
    return _recip_row(row)


@router.patch("/mail-recipients/{recipient_id}")
async def boss_update_recipient(
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
    # 限 source='pananora'（Boss 不可改 admin 收件人）
    row = (await db.execute(text(f"""
        UPDATE ems_mail_recipient SET {", ".join(sets)}
        WHERE recipient_id = :id AND source = 'pananora'
        RETURNING recipient_id, email, source, notify_enabled, description, created_at, created_by
    """), params)).mappings().fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail=f"pananora recipient {recipient_id} not found")
    await db.commit()
    return _recip_row(row)


@router.delete("/mail-recipients/{recipient_id}")
async def boss_delete_recipient(
    recipient_id: int = Path(..., ge=1),
    db: AsyncSession = Depends(get_db),
):
    res = await db.execute(text(
        "DELETE FROM ems_mail_recipient WHERE recipient_id = :id AND source = 'pananora'"
    ), {"id": recipient_id})
    if (res.rowcount or 0) == 0:
        raise HTTPException(status_code=404, detail=f"pananora recipient {recipient_id} not found")
    await db.commit()
    return {"deleted": recipient_id}


# ===== thermal recipients (溫度告警獨立一份；M-P11-E103 契約) =====
# 與電流收件人(source='pananora')平行；溫度告警(event_kind='thermal_alarm')
# 由 mail_worker 查 source='thermal' 清單發送。邏輯複製 mail-recipients 換 source。

@router.get("/thermal-recipients")
async def boss_list_thermal_recipients(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(text("""
        SELECT recipient_id, email, source, notify_enabled, description, created_at, created_by
        FROM ems_mail_recipient WHERE source = 'thermal' ORDER BY recipient_id
    """))).mappings().all()
    return [_recip_row(r) for r in rows]


@router.post("/thermal-recipients")
async def boss_create_thermal_recipient(
    body: BossMailRecipientCreate = Body(...),
    db: AsyncSession = Depends(get_db),
):
    email = _validate_email(body.email)
    try:
        row = (await db.execute(text("""
            INSERT INTO ems_mail_recipient (email, source, notify_enabled, description, created_by)
            VALUES (:email, 'thermal', :enabled, :desc, 'thermal')
            RETURNING recipient_id, email, source, notify_enabled, description, created_at, created_by
        """), {"email": email, "enabled": body.notify_enabled, "desc": body.description})).mappings().fetchone()
    except Exception as e:
        if "unique" in str(e).lower() or "duplicate" in str(e).lower():
            raise HTTPException(status_code=409, detail=f"email already exists: {email}")
        raise
    await db.commit()
    return _recip_row(row)


@router.patch("/thermal-recipients/{recipient_id}")
async def boss_update_thermal_recipient(
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
        WHERE recipient_id = :id AND source = 'thermal'
        RETURNING recipient_id, email, source, notify_enabled, description, created_at, created_by
    """), params)).mappings().fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail=f"thermal recipient {recipient_id} not found")
    await db.commit()
    return _recip_row(row)


@router.delete("/thermal-recipients/{recipient_id}")
async def boss_delete_thermal_recipient(
    recipient_id: int = Path(..., ge=1),
    db: AsyncSession = Depends(get_db),
):
    res = await db.execute(text(
        "DELETE FROM ems_mail_recipient WHERE recipient_id = :id AND source = 'thermal'"
    ), {"id": recipient_id})
    if (res.rowcount or 0) == 0:
        raise HTTPException(status_code=404, detail=f"thermal recipient {recipient_id} not found")
    await db.commit()
    return {"deleted": recipient_id}
