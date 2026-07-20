"""V2-final Alarm Rule API router (M-PM-313 階段2 P1).

管理 ems_alarm_rule（thermal 閾值 config 表）。admin-ui IR 標籤管理頁「熱像溫度閾值」
區塊用 GET + PATCH 讀寫三級閾值（info 60 / warn 75 / critical 90）。

⚠️ ems_alarm_rule 是「閾值 config」表，與舊 ems_alert_rule（狀態機規則引擎，v1_alerts.py）
   範式不同，勿混用（M-PM-313 設計 D2）。

Endpoints（全掛 verify_admin_token）：
- GET    /v1/admin/alarm-rules            列出（可 filter rule_type）
- POST   /v1/admin/alarm-rules            新增規則
- PATCH  /v1/admin/alarm-rules/{rule_id}  更新 threshold_value / enabled / severity / description
- DELETE /v1/admin/alarm-rules/{rule_id}  刪除
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Path, Query
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_db, verify_admin_token

router = APIRouter(
    prefix="/v1/admin",
    tags=["admin-alarms"],
    dependencies=[Depends(verify_admin_token)],
)

VALID_SEVERITY = ("info", "warn", "critical")


# ===== Pydantic =====

class AlarmRuleCreate(BaseModel):
    rule_type: str = Field("thermal_temp_exceed", max_length=30)
    device_scope: Optional[str] = Field("all_811c", max_length=30)
    device_id: Optional[str] = Field(None, max_length=64)
    threshold_value: float
    threshold_unit: Optional[str] = Field("C", max_length=10)
    severity: str = Field("warn")
    description: Optional[str] = Field(None, max_length=255)


class AlarmRuleUpdate(BaseModel):
    threshold_value: Optional[float] = None
    severity: Optional[str] = None
    enabled: Optional[bool] = None
    description: Optional[str] = Field(None, max_length=255)


def _row_to_dict(r) -> dict:
    return {
        "rule_id": r["rule_id"],
        "rule_type": r["rule_type"],
        "device_scope": r["device_scope"],
        "device_id": r["device_id"],
        "threshold_value": float(r["threshold_value"]) if r["threshold_value"] is not None else None,
        "threshold_unit": r["threshold_unit"],
        "severity": r["severity"],
        "source": r["source"],
        "enabled": r["enabled"],
        "description": r["description"],
        "created_at": r["created_at"].isoformat() if r["created_at"] else None,
    }


# ===== GET =====

@router.get("/alarm-rules")
async def list_alarm_rules(
    rule_type: str | None = Query(None, description="filter rule_type, e.g. thermal_temp_exceed"),
    db: AsyncSession = Depends(get_db),
):
    """列出 alarm 規則（threshold_value ASC）；可 filter rule_type。"""
    sql = """
        SELECT rule_id, rule_type, device_scope, device_id, threshold_value,
               threshold_unit, severity, source, enabled, description, created_at
        FROM ems_alarm_rule
    """
    params: dict = {}
    if rule_type is not None:
        sql += " WHERE rule_type = :rt"
        params["rt"] = rule_type
    sql += " ORDER BY rule_type, threshold_value ASC"
    rows = (await db.execute(text(sql), params)).mappings().all()
    return [_row_to_dict(r) for r in rows]


# ===== POST =====

@router.post("/alarm-rules")
async def create_alarm_rule(
    body: AlarmRuleCreate = Body(...),
    db: AsyncSession = Depends(get_db),
):
    if body.severity not in VALID_SEVERITY:
        raise HTTPException(status_code=422, detail=f"severity must be one of: {VALID_SEVERITY}")
    row = (await db.execute(text("""
        INSERT INTO ems_alarm_rule
            (rule_type, device_scope, device_id, threshold_value, threshold_unit,
             severity, source, enabled, description, created_by)
        VALUES
            (:rule_type, :device_scope, :device_id, :threshold_value, :threshold_unit,
             :severity, 'admin', TRUE, :description, 'admin')
        RETURNING rule_id, rule_type, device_scope, device_id, threshold_value,
                  threshold_unit, severity, source, enabled, description, created_at
    """), body.model_dump())).mappings().fetchone()
    await db.commit()
    return _row_to_dict(row)


# ===== PATCH =====

@router.patch("/alarm-rules/{rule_id}")
async def update_alarm_rule(
    rule_id: int = Path(..., ge=1),
    body: AlarmRuleUpdate = Body(...),
    db: AsyncSession = Depends(get_db),
):
    """更新 threshold_value / severity / enabled / description（只動有給的欄位）。"""
    if body.severity is not None and body.severity not in VALID_SEVERITY:
        raise HTTPException(status_code=422, detail=f"severity must be one of: {VALID_SEVERITY}")

    sets: list[str] = []
    params: dict = {"rule_id": rule_id}
    for field in ("threshold_value", "severity", "enabled", "description"):
        val = getattr(body, field)
        if val is not None:
            sets.append(f"{field} = :{field}")
            params[field] = val
    if not sets:
        raise HTTPException(status_code=422, detail="no fields to update")

    row = (await db.execute(text(f"""
        UPDATE ems_alarm_rule SET {", ".join(sets)}
        WHERE rule_id = :rule_id
        RETURNING rule_id, rule_type, device_scope, device_id, threshold_value,
                  threshold_unit, severity, source, enabled, description, created_at
    """), params)).mappings().fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail=f"alarm rule {rule_id} not found")
    await db.commit()
    return _row_to_dict(row)


# ===== DELETE =====

@router.delete("/alarm-rules/{rule_id}")
async def delete_alarm_rule(
    rule_id: int = Path(..., ge=1),
    db: AsyncSession = Depends(get_db),
):
    res = await db.execute(
        text("DELETE FROM ems_alarm_rule WHERE rule_id = :rule_id"),
        {"rule_id": rule_id},
    )
    if (res.rowcount or 0) == 0:
        raise HTTPException(status_code=404, detail=f"alarm rule {rule_id} not found")
    await db.commit()
    return {"deleted": rule_id}
