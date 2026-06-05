"""V2-final Edge router — enroll + config pull + config ack.

所有路徑以 /v1 前綴。
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import (
    get_client_ip,
    get_db,
    verify_admin_token,
    verify_edge,
)
from app.models import EmsEdge
from app.schemas.config_sync import (
    ConfigAckRequest,
    ConfigAckResponse,
    DesiredConfigResponse,
)
from app.schemas.enroll import (
    EnrollRequest,
    EnrollResponse,
    EnrollStatusResponse,
)
from app.services import config_service, enroll_service

router = APIRouter(prefix="/v1", tags=["edge"])


# ========== Enroll (無需既有 token) ==========

@router.post("/edge/enroll", response_model=EnrollResponse)
async def edge_enroll(body: EnrollRequest, db: AsyncSession = Depends(get_db)):
    """Edge 首次上線或指紋漂移時呼叫。不需 Bearer token。"""
    result = await enroll_service.enroll_edge(
        db,
        edge_id=body.edge_id,
        hostname=body.hostname,
        fingerprint=body.fingerprint,
        site_code=body.site_code,
        claimed_edge_name=body.claimed_edge_name,
    )
    return EnrollResponse(**result)


@router.get("/edge/enroll/{edge_id}", response_model=EnrollStatusResponse)
async def edge_enroll_status(edge_id: str, db: AsyncSession = Depends(get_db)):
    """Edge polling 核可狀態。approved 後首次呼叫會回傳明文 token（一次性）。"""
    result = await enroll_service.get_enroll_status(db, edge_id)
    return EnrollStatusResponse(
        request_id="",
        edge_id=result["edge_id"],
        status=result["status"],
        token=result.get("token"),
        approved_at=result.get("approved_at"),
    )


# ========== Desired Config Pull（需 Edge Bearer + Fingerprint） ==========

async def _verify_edge_dep(
    request: Request,
    db: AsyncSession = Depends(get_db),
    authorization: str | None = None,
    x_edge_fingerprint: str | None = None,
) -> EmsEdge:
    """Wrapper 呼叫 verify_edge（保持 Depends 能注入 headers）。"""
    from fastapi import Header
    raise NotImplementedError  # placeholder — 使用 Depends(verify_edge)


@router.get("/edges/{edge_id}/desired-config", response_model=DesiredConfigResponse)
async def get_desired_config(
    edge_id: str,
    edge: EmsEdge = Depends(verify_edge),
    db: AsyncSession = Depends(get_db),
):
    """Edge 拉取當前期望配置。"""
    if edge.edge_id != edge_id:
        raise HTTPException(status_code=403, detail="edge_id mismatch with token")
    return await config_service.build_desired_config(db, edge_id)


@router.post("/edges/{edge_id}/config/ack", response_model=ConfigAckResponse)
async def post_config_ack(
    edge_id: str,
    body: ConfigAckRequest,
    edge: EmsEdge = Depends(verify_edge),
    db: AsyncSession = Depends(get_db),
):
    """Edge 回報套用結果。"""
    if edge.edge_id != edge_id:
        raise HTTPException(status_code=403, detail="edge_id mismatch with token")
    await config_service.ack_config(
        db,
        edge_id=edge_id,
        applied_version=body.applied_version,
        applied_at=body.applied_at,
        result=body.result,
        errors=body.errors,
    )
    return ConfigAckResponse(status="ok")


# ========== Edge 主機健康心跳（edge 溫度採集紀錄 Phase 1）+ 溫度告警（Phase 2）==========

# CPU 溫度告警閾值（依 Raspberry Pi 4B 原廠 datasheet；thermal_zone0=晶片溫度）
#   80°C：起始降頻（throttle）→ warn
#   85°C：強制節流（force throttle，原廠上限）→ critical
CPU_TEMP_WARN_C = 80.0
CPU_TEMP_CRIT_C = 85.0


def _cpu_temp_level(t: float | None) -> str:
    if t is None:
        return "unknown"
    if t >= CPU_TEMP_CRIT_C:
        return "crit"
    if t >= CPU_TEMP_WARN_C:
        return "warn"
    return "normal"


class EdgeHeartbeatRequest(BaseModel):
    """Edge 主機健康心跳 body（Phase 1 先收 CPU 核心溫度；extra 供未來 disk/uptime 擴充）。"""
    cpu_temp_c: float | None = Field(None, description="CPU 核心溫度 °C（讀 /sys/class/thermal）")
    extra: dict[str, Any] | None = Field(None, description="未來擴充：disk_pct / uptime_sec 等")


@router.post("/edges/{edge_id}/heartbeat")
async def post_edge_heartbeat(
    edge_id: str,
    body: EdgeHeartbeatRequest,
    request: Request,
    edge: EmsEdge = Depends(verify_edge),
    db: AsyncSession = Depends(get_db),
):
    """Edge 主機健康心跳 — 寫入 ems_edge_heartbeat（payload_json 帶 cpu_temp_c）。

    Phase 1：INSERT ems_edge_heartbeat。
    Phase 2（溫度告警）：比對前一筆溫度做「跨越偵測」，跨越 80/85°C 才寫 ems_events
      （避免每 60s 洗版）→ 事件履歷頁可見。隔離端點；不碰既有 ingest/config-sync/auth。
    """
    if edge.edge_id != edge_id:
        raise HTTPException(status_code=403, detail="edge_id mismatch with token")

    cur_temp = body.cpu_temp_c

    # Phase 2：先取前一筆溫度（INSERT 前），供跨越偵測
    prev_temp: float | None = None
    if cur_temp is not None:
        row = (await db.execute(text("""
            SELECT (payload_json->>'cpu_temp_c')::float
            FROM ems_edge_heartbeat
            WHERE edge_id = :edge_id AND payload_json ? 'cpu_temp_c'
            ORDER BY hb_ts DESC LIMIT 1
        """), {"edge_id": edge_id})).fetchone()
        prev_temp = row[0] if row else None

    payload: dict[str, Any] = {}
    if cur_temp is not None:
        payload["cpu_temp_c"] = cur_temp
    if body.extra:
        payload.update(body.extra)

    await db.execute(text("""
        INSERT INTO ems_edge_heartbeat (edge_id, hb_ts, ip_addr, payload_json)
        VALUES (:edge_id, NOW(), :ip, CAST(:payload AS JSONB))
    """), {
        "edge_id": edge_id,
        "ip": get_client_ip(request),
        "payload": json.dumps(payload),
    })

    # Phase 2：跨越偵測 → 寫 ems_events（event_kind=edge_lifecycle；事件履歷頁可見）
    if cur_temp is not None:
        cur_lv, prev_lv = _cpu_temp_level(cur_temp), _cpu_temp_level(prev_temp)
        evt: dict[str, str] | None = None
        # 向上跨越（往更嚴重）才告警；同級不重發 → 防洗版
        if cur_lv == "crit" and prev_lv != "crit":
            evt = {"sev": "critical", "msg": f"CPU 溫度危險：{cur_temp:.1f}°C（已達 85°C 強制節流）"}
        elif cur_lv == "warn" and prev_lv == "normal":
            evt = {"sev": "warn", "msg": f"CPU 溫度過高：{cur_temp:.1f}°C（已達 80°C 起始降頻）"}
        elif cur_lv == "normal" and prev_lv in ("warn", "crit"):
            evt = {"sev": "info", "msg": f"CPU 溫度恢復正常：{cur_temp:.1f}°C"}
        if evt is not None:
            await db.execute(text("""
                INSERT INTO ems_events (ts, event_kind, severity, edge_id, message, data_json)
                VALUES (NOW(), 'edge_lifecycle', :sev, :edge_id, :msg, CAST(:data AS JSONB))
            """), {
                "sev": evt["sev"], "edge_id": edge_id, "msg": evt["msg"],
                "data": json.dumps({"cpu_temp_c": cur_temp, "prev_cpu_temp_c": prev_temp}),
            })

    await db.commit()
    return {"status": "ok", "edge_id": edge_id, "recorded": payload}


# ========== Admin 管理 Edge ==========

@router.post("/admin/edges/{edge_id}/approve", dependencies=[Depends(verify_admin_token)])
async def admin_approve_edge(
    edge_id: str,
    approver: str = "admin",
    db: AsyncSession = Depends(get_db),
):
    ok = await enroll_service.approve_edge(db, edge_id, approver)
    if not ok:
        raise HTTPException(status_code=400, detail="cannot approve (status or not found)")
    return {"status": "approved"}


@router.post("/admin/edges/{edge_id}/revoke", dependencies=[Depends(verify_admin_token)])
async def admin_revoke_edge(
    edge_id: str,
    reason: str = "",
    actor: str = "admin",
    db: AsyncSession = Depends(get_db),
):
    ok = await enroll_service.revoke_edge(db, edge_id, reason, actor)
    if not ok:
        raise HTTPException(status_code=404, detail="edge not found")
    return {"status": "revoked"}


@router.post("/admin/edges/{edge_id}/maintenance", dependencies=[Depends(verify_admin_token)])
async def admin_maintenance_edge(
    edge_id: str,
    actor: str = "admin",
    db: AsyncSession = Depends(get_db),
):
    ok, reason = await enroll_service.set_maintenance(db, edge_id, actor)
    if not ok:
        raise HTTPException(status_code=400, detail=reason)
    return {"status": "maintenance"}


@router.post("/admin/edges/{edge_id}/resume", dependencies=[Depends(verify_admin_token)])
async def admin_resume_edge(
    edge_id: str,
    actor: str = "admin",
    db: AsyncSession = Depends(get_db),
):
    ok, reason = await enroll_service.resume_edge(db, edge_id, actor)
    if not ok:
        raise HTTPException(status_code=400, detail=reason)
    return {"status": "approved"}


@router.get("/admin/edges/{edge_id}/config-sync-status", dependencies=[Depends(verify_admin_token)])
async def admin_edge_config_sync_status(
    edge_id: str,
    db: AsyncSession = Depends(get_db),
):
    """ADR-026 DR-026-04 同步狀態可觀測性（審查 R3）。"""
    status = await config_service.get_sync_status(db, edge_id)
    if status is None:
        raise HTTPException(status_code=404, detail="edge not found")
    return status


@router.post("/admin/edges/{edge_id}/resync", dependencies=[Depends(verify_admin_token)])
async def admin_edge_resync(
    edge_id: str,
    db: AsyncSession = Depends(get_db),
):
    """強制 Edge 重拉 config — bump config_version 觸發下次 heartbeat diff（審查 R10）。"""
    new_version = await config_service.bump_edge_config_version(db, edge_id)
    if new_version == 0:
        raise HTTPException(status_code=404, detail="edge not found")
    return {"triggered": True, "new_version": new_version}
