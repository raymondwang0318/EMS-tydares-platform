"""V2-final Alert API router (T-S11C-002 AC 8 / M-PM-085 §3 補派).

3 endpoints 對接 admin-ui Phase γ/δ：
- GET /v1/alerts/active     當前 active alerts（filter device_id / edge_id / severity）
- GET /v1/alerts/history    歷史事件流（filter device_id / edge_id / event_type / since / until / severity / limit）
- PUT /v1/alerts/{alert_id}/ack  手動 ack；status='active'→'acknowledged' + history INSERT

Reference:
- [[ADR-028-IR-Device-Health-Monitoring-And-Edge-Liveness]] §8.3
- [[T-S11C-002]] §AC 8
- [[P12_設備異常警報系統_前導文_2026-04-18]] §6
- [[M-PM-085]] §3.2 規格
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Path, Query
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_db, verify_admin_token

router = APIRouter(
    prefix="/v1/alerts",
    tags=["alerts"],
    dependencies=[Depends(verify_admin_token)],
)


# ===== Pydantic =====

class AckRequest(BaseModel):
    acked_by: str = Field(..., min_length=1, max_length=100, description="操作者 (必填)")
    ack_note: Optional[str] = Field(None, max_length=500, description="備註 (選填)")


# ===== GET /v1/alerts/active =====

@router.get("/active")
async def list_active_alerts(
    device_id: str | None = Query(None, description="filter device_id"),
    edge_id: str | None = Query(None, description="filter edge_id"),
    severity: str | None = Query(None, description="filter severity (critical/warning/info)"),
    db: AsyncSession = Depends(get_db),
):
    """當前 active alerts；可 filter device_id / edge_id / severity.

    Excludes auto_resolved=TRUE (軟體類已自動解除).
    JOIN ems_alert_rule for rule_name / category / scope。
    """
    if severity is not None and severity not in ("critical", "warning", "info"):
        raise HTTPException(status_code=422, detail="severity must be one of: critical/warning/info")

    sql = """
        SELECT
            a.alert_id, a.rule_id, r.rule_name, r.category, r.scope,
            a.device_id, a.edge_id, a.severity, a.status,
            a.triggered_at, a.message,
            a.trigger_value, a.trigger_metric,
            a.last_value, a.last_seen_at,
            a.acked_by, a.acked_at, a.ack_note,
            a.auto_resolved, a.auto_resolved_at
        FROM ems_alert_active a
        JOIN ems_alert_rule r ON a.rule_id = r.rule_id
        WHERE a.auto_resolved = FALSE
    """
    params: dict = {}
    if device_id is not None:
        sql += " AND a.device_id = :device_id"
        params["device_id"] = device_id
    if edge_id is not None:
        sql += " AND a.edge_id = :edge_id"
        params["edge_id"] = edge_id
    if severity is not None:
        sql += " AND a.severity = :severity"
        params["severity"] = severity
    sql += " ORDER BY a.triggered_at DESC"

    rows = (await db.execute(text(sql), params)).mappings().all()
    return [
        {
            "alert_id": r["alert_id"],
            "rule_id": r["rule_id"],
            "rule_name": r["rule_name"],
            "category": r["category"],
            "scope": r["scope"],
            "device_id": r["device_id"],
            "edge_id": r["edge_id"],
            "severity": r["severity"],
            "status": r["status"],
            "triggered_at": r["triggered_at"].isoformat() if r["triggered_at"] else None,
            "message": r["message"],
            "trigger_value": r["trigger_value"],
            "trigger_metric": r["trigger_metric"],
            "last_value": r["last_value"],
            "last_seen_at": r["last_seen_at"].isoformat() if r["last_seen_at"] else None,
            "acked_by": r["acked_by"],
            "acked_at": r["acked_at"].isoformat() if r["acked_at"] else None,
            "ack_note": r["ack_note"],
        }
        for r in rows
    ]


# ===== GET /v1/alerts/history =====

VALID_EVENT_TYPES = (
    "triggered", "acknowledged", "auto_resolved",
    "cleared", "escalated", "suppressed_by_edge_down",
)
VALID_SEVERITIES = ("critical", "warning", "info")


@router.get("/history")
async def list_alert_history(
    device_id: str | None = Query(None),
    edge_id: str | None = Query(None),
    event_type: str | None = Query(None, description="triggered/acknowledged/auto_resolved/cleared/escalated/suppressed_by_edge_down"),
    since: datetime | None = Query(None, description="預設 NOW() - 7 days"),
    until: datetime | None = Query(None, description="預設 NOW()"),
    severity: str | None = Query(None),
    limit: int = Query(200, ge=1, le=1000, description="防爆量；最大 1000"),
    db: AsyncSession = Depends(get_db),
):
    """歷史事件流；filter 多條件 + ORDER BY ts DESC LIMIT N.

    特殊事件類型 'suppressed_by_edge_down' 可用作「Edge-down 抑制」軌跡查詢。
    """
    if event_type is not None and event_type not in VALID_EVENT_TYPES:
        raise HTTPException(
            status_code=422,
            detail=f"event_type must be one of: {', '.join(VALID_EVENT_TYPES)}",
        )
    if severity is not None and severity not in VALID_SEVERITIES:
        raise HTTPException(status_code=422, detail="severity must be one of: critical/warning/info")

    # 時間預設：since=NOW()-7d, until=NOW()
    now = datetime.now(timezone.utc)
    if since is None:
        since = now - timedelta(days=7)
    if until is None:
        until = now
    if since >= until:
        raise HTTPException(status_code=422, detail="since must be < until")

    sql = """
        SELECT
            ts, alert_id, rule_id, event_type,
            device_id, edge_id, value, message,
            severity, actor, note
        FROM ems_alert_history
        WHERE ts >= :since AND ts <= :until
    """
    params: dict = {"since": since, "until": until}
    if device_id is not None:
        sql += " AND device_id = :device_id"
        params["device_id"] = device_id
    if edge_id is not None:
        sql += " AND edge_id = :edge_id"
        params["edge_id"] = edge_id
    if event_type is not None:
        sql += " AND event_type = :event_type"
        params["event_type"] = event_type
    if severity is not None:
        sql += " AND severity = :severity"
        params["severity"] = severity
    sql += " ORDER BY ts DESC LIMIT :limit"
    params["limit"] = limit

    rows = (await db.execute(text(sql), params)).mappings().all()
    return [
        {
            "ts": r["ts"].isoformat() if r["ts"] else None,
            "alert_id": r["alert_id"],
            "rule_id": r["rule_id"],
            "event_type": r["event_type"],
            "device_id": r["device_id"],
            "edge_id": r["edge_id"],
            "value": r["value"],
            "message": r["message"],
            "severity": r["severity"],
            "actor": r["actor"],
            "note": r["note"],
        }
        for r in rows
    ]


# ===== PUT /v1/alerts/{alert_id}/ack =====

@router.put("/{alert_id}/ack")
async def acknowledge_alert(
    alert_id: int = Path(..., ge=1),
    body: AckRequest = Body(...),
    db: AsyncSession = Depends(get_db),
):
    """手動 ack；ems_alert_active.status active→acknowledged + history INSERT.

    重複 ack 不重複寫 history（idempotent；若已 acknowledged 直接 200 回最新狀態）。
    """
    # 1. 查現況
    row = (await db.execute(text("""
        SELECT alert_id, rule_id, device_id, edge_id, severity, status,
               acked_by, acked_at, ack_note
        FROM ems_alert_active
        WHERE alert_id = :alert_id
    """), {"alert_id": alert_id})).fetchone()

    if row is None:
        raise HTTPException(status_code=404, detail=f"alert_id {alert_id} not found in ems_alert_active")

    (existing_alert_id, rule_id, device_id, edge_id, severity, status,
     existing_acked_by, existing_acked_at, existing_ack_note) = row

    # 2. 若已 acknowledged → idempotent 回現況
    if status == "acknowledged":
        return {
            "alert_id": existing_alert_id,
            "status": status,
            "acked_by": existing_acked_by,
            "acked_at": existing_acked_at.isoformat() if existing_acked_at else None,
            "ack_note": existing_ack_note,
            "message": "already acknowledged (idempotent)",
        }

    # 3. UPDATE active + INSERT history
    update_row = (await db.execute(text("""
        UPDATE ems_alert_active
        SET status = 'acknowledged',
            acked_by = :acked_by,
            acked_at = NOW(),
            ack_note = :ack_note
        WHERE alert_id = :alert_id
        RETURNING acked_at
    """), {
        "alert_id": alert_id,
        "acked_by": body.acked_by,
        "ack_note": body.ack_note,
    })).fetchone()

    await db.execute(text("""
        INSERT INTO ems_alert_history
            (ts, alert_id, rule_id, event_type, device_id, edge_id,
             severity, actor, note)
        VALUES
            (NOW(), :alert_id, :rule_id, 'acknowledged',
             :device_id, :edge_id, :severity, :actor, :note)
    """), {
        "alert_id": alert_id, "rule_id": rule_id,
        "device_id": device_id, "edge_id": edge_id,
        "severity": severity,
        "actor": body.acked_by,
        "note": body.ack_note,
    })

    await db.commit()

    return {
        "alert_id": alert_id,
        "status": "acknowledged",
        "acked_by": body.acked_by,
        "acked_at": update_row[0].isoformat() if update_row and update_row[0] else None,
        "ack_note": body.ack_note,
        "message": "acknowledged",
    }
