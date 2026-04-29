"""V2-final Admin router (ADR-026) — UI 管理 device / edge / ecsu / billing / model.

精簡成 5 組 CRUD，取代 16 個 fnd_* 舊 endpoint。
每次改動 device 相關即 bump 對應 edge.config_version 觸發 Edge pull。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_db, verify_admin_token
from app.models import (
    EmsDevice,
    EmsDeviceModbus,
    EmsDeviceThermal,
    EmsEdge,
    EmsEvent,
    FndBillingRule,
    FndDeviceModel,
    FndDeviceModelCircuit,
    FndDeviceModelParam,
    FndEcsu,
    FndEcsuCircuitAssgn,
    FndElectricParameter,
)
from app.services import config_service

router = APIRouter(prefix="/v1/admin", tags=["admin"], dependencies=[Depends(verify_admin_token)])


# ========== /admin/edges ==========

@router.get("/edges")
async def list_edges(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(EmsEdge).order_by(EmsEdge.edge_id))).scalars().all()
    return [
        {
            "edge_id": e.edge_id,
            "edge_name": e.edge_name,
            "site_code": e.site_code,
            "hostname": e.hostname,
            "status": e.status,
            "config_version": e.config_version,
            "fingerprint": (e.fingerprint or "")[:16],
            "previous_fingerprints": e.previous_fingerprints or [],
            "last_seen_at": e.last_seen_at.isoformat() if e.last_seen_at else None,
            "last_seen_ip": e.last_seen_ip,
            "registered_at": e.registered_at.isoformat() if e.registered_at else None,
            "approved_at": e.approved_at.isoformat() if e.approved_at else None,
        }
        for e in rows
    ]


@router.post("/edges/{edge_id}/devices/bootstrap")
async def bootstrap_placeholder_device(
    edge_id: str,
    db: AsyncSession = Depends(get_db),
):
    """為 Admin UI Wizard 建立 placeholder device（scan 掃描佔位用）。

    Wizard Step 1 若 edge 無既有 device，呼叫本 endpoint 取得 device_id
    作為後續 scan command 的 FK target。scan 完成 confirm_devices 時
    建真實 device 取代 placeholder。

    回傳：{"device_id": "_placeholder_<8chars>"}

    對應 T-P12-006 scope（M-PM-054 §三）；M-P10-014 §根因修復。
    """
    import uuid

    edge = await db.get(EmsEdge, edge_id)
    if not edge:
        raise HTTPException(status_code=404, detail=f"edge {edge_id} not found")

    device_id = f"_placeholder_{uuid.uuid4().hex[:8]}"

    dev = EmsDevice(
        device_id=device_id,
        edge_id=edge_id,
        device_kind="other",
        display_name="掃描佔位（Wizard bootstrap）",
        enabled=True,
    )
    db.add(dev)

    db.add(EmsEvent(
        event_kind="operation",
        severity="info",
        edge_id=edge_id,
        device_id=device_id,
        actor="admin",
        message="placeholder device created (wizard bootstrap)",
        data_json={"source": "wizard_bootstrap"},
    ))

    await db.commit()
    return {"device_id": device_id}


# ========== /admin/devices ==========

@router.get("/devices")
async def list_devices(
    edge_id: str | None = None,
    kind: str | None = None,
    db: AsyncSession = Depends(get_db),
):
    stmt = select(EmsDevice).where(EmsDevice.deleted_at.is_(None))
    if edge_id:
        stmt = stmt.where(EmsDevice.edge_id == edge_id)
    if kind:
        stmt = stmt.where(EmsDevice.device_kind == kind)
    rows = (await db.execute(stmt)).scalars().all()
    return [
        {
            "device_id": d.device_id,
            "edge_id": d.edge_id,
            "device_kind": d.device_kind,
            "display_name": d.display_name,
            "model_id": d.model_id,
            "config_version": d.config_version,
            "enabled": d.enabled,
        }
        for d in rows
    ]


@router.post("/devices")
async def create_device(body: dict[str, Any] = Body(...), db: AsyncSession = Depends(get_db)):
    """建立 device + subtype（body 需含 device_id, edge_id, device_kind, + 對應子表欄位）。"""
    device_id = body["device_id"]
    edge_id = body["edge_id"]
    kind = body["device_kind"]

    dev = EmsDevice(
        device_id=device_id,
        edge_id=edge_id,
        device_kind=kind,
        display_name=body.get("display_name"),
        model_id=body.get("model_id"),
        enabled=body.get("enabled", True),
    )
    db.add(dev)

    if kind == "modbus_meter":
        modbus = body.get("modbus", {})
        db.add(EmsDeviceModbus(
            device_id=device_id,
            slave_id=modbus["slave_id"],
            bus_id=modbus.get("bus_id"),
            transport=modbus.get("transport", "rtu"),
            tcp_host=modbus.get("tcp_host"),
            tcp_port=modbus.get("tcp_port"),
            poll_interval_sec=modbus.get("poll_interval_sec", 30),
            endianness=modbus.get("endianness", "big"),
        ))
    elif kind == "thermal":
        thermal = body.get("thermal", {})
        db.add(EmsDeviceThermal(
            device_id=device_id,
            camera_model=thermal.get("camera_model"),
            mac_addr=thermal.get("mac_addr"),
            zone_count=thermal.get("zone_count", 1),
            upload_interval_sec=thermal.get("upload_interval_sec", 5),
        ))

    db.add(EmsEvent(
        event_kind="operation",
        severity="info",
        edge_id=edge_id,
        device_id=device_id,
        actor=body.get("actor", "admin"),
        message=f"device created: {kind}",
        data_json=body,
    ))
    await db.commit()
    new_version = await config_service.bump_edge_config_version(db, edge_id)
    return {"status": "created", "device_id": device_id, "edge_config_version": new_version}


@router.patch("/devices/{device_id}")
async def update_device(
    device_id: str,
    body: dict[str, Any] = Body(...),
    db: AsyncSession = Depends(get_db),
):
    dev = await db.get(EmsDevice, device_id)
    if not dev:
        raise HTTPException(404, "device not found")

    for k in ("display_name", "enabled", "model_id"):
        if k in body:
            setattr(dev, k, body[k])

    if dev.device_kind == "modbus_meter" and "modbus" in body:
        mb = await db.get(EmsDeviceModbus, device_id)
        modbus_patch = body["modbus"]
        for k in ("slave_id", "bus_id", "transport", "tcp_host", "tcp_port", "poll_interval_sec", "endianness"):
            if k in modbus_patch and mb:
                setattr(mb, k, modbus_patch[k])

    dev.config_version += 1
    db.add(EmsEvent(
        event_kind="operation",
        severity="info",
        edge_id=dev.edge_id,
        device_id=device_id,
        actor=body.get("actor", "admin"),
        message="device updated",
        data_json=body,
    ))
    await db.commit()
    new_version = await config_service.bump_edge_config_version(db, dev.edge_id)
    return {"status": "updated", "edge_config_version": new_version}


@router.delete("/devices/{device_id}")
async def soft_delete_device(device_id: str, db: AsyncSession = Depends(get_db)):
    from datetime import datetime, timezone as tz
    dev = await db.get(EmsDevice, device_id)
    if not dev:
        raise HTTPException(404, "device not found")
    dev.deleted_at = datetime.now(tz.utc)
    db.add(EmsEvent(
        event_kind="operation",
        severity="warn",
        edge_id=dev.edge_id,
        device_id=device_id,
        message="device soft-deleted",
    ))
    await db.commit()
    new_version = await config_service.bump_edge_config_version(db, dev.edge_id)
    return {"status": "deleted", "edge_config_version": new_version}


# ========== /admin/ecsu ==========

@router.get("/ecsu")
async def list_ecsu(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(FndEcsu).order_by(FndEcsu.display_seq, FndEcsu.ecsu_id))).scalars().all()
    return [
        {
            "ecsu_id": e.ecsu_id,
            "ecsu_code": e.ecsu_code,
            "ecsu_name": e.ecsu_name,
            "parent_id": e.parent_id,
            "display_seq": e.display_seq,
            "enabled": e.enabled,
        }
        for e in rows
    ]


@router.post("/ecsu")
async def create_ecsu(body: dict[str, Any] = Body(...), db: AsyncSession = Depends(get_db)):
    row = FndEcsu(**{k: body[k] for k in body if k in {
        "ecsu_code", "ecsu_name", "parent_id", "display_seq", "enabled", "remark_desc"
    }})
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return {"status": "created", "ecsu_id": row.ecsu_id}


@router.get("/ecsu-assgn")
async def list_ecsu_assgn(ecsu_id: int | None = None, db: AsyncSession = Depends(get_db)):
    stmt = select(FndEcsuCircuitAssgn)
    if ecsu_id:
        stmt = stmt.where(FndEcsuCircuitAssgn.ecsu_id == ecsu_id)
    rows = (await db.execute(stmt)).scalars().all()
    return [
        {
            "assgn_id": r.assgn_id,
            "ecsu_id": r.ecsu_id,
            "device_id": r.device_id,
            "circuit_code": r.circuit_code,
            "sign": r.sign,
            "enabled": r.enabled,
        }
        for r in rows
    ]


# ========== /admin/billing ==========

@router.get("/billing")
async def list_billing(kind: str | None = None, db: AsyncSession = Depends(get_db)):
    stmt = select(FndBillingRule)
    if kind:
        stmt = stmt.where(FndBillingRule.rule_kind == kind)
    rows = (await db.execute(stmt)).scalars().all()
    return [
        {
            "rule_id": r.rule_id,
            "rule_kind": r.rule_kind,
            "rule_code": r.rule_code,
            "rule_name": r.rule_name,
            "effective_from": str(r.effective_from) if r.effective_from else None,
            "effective_to": str(r.effective_to) if r.effective_to else None,
            "rule_json": r.rule_json,
            "enabled": r.enabled,
        }
        for r in rows
    ]


# ========== /admin/device-models ==========

@router.get("/device-models")
async def list_device_models(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(FndDeviceModel))).scalars().all()
    return [
        {
            "model_id": m.model_id,
            "model_code": m.model_code,
            "model_name": m.model_name,
            "model_kind": m.model_kind,
            "vendor": m.vendor,
            "slave_id_default": m.slave_id_default,
        }
        for m in rows
    ]


@router.get("/device-models/{model_id}/circuits")
async def list_model_circuits(model_id: int, db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(
        select(FndDeviceModelCircuit).where(FndDeviceModelCircuit.model_id == model_id)
    )).scalars().all()
    return [
        {
            "circuit_id": c.circuit_id,
            "circuit_code": c.circuit_code,
            "circuit_name": c.circuit_name,
            "display_seq": c.display_seq,
        }
        for c in rows
    ]


# ========== /admin/electric-parameters ==========

@router.get("/electric-parameters")
async def list_electric_parameters(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(
        select(FndElectricParameter).order_by(FndElectricParameter.display_seq)
    )).scalars().all()
    return [
        {
            "electric_parameter_id": p.electric_parameter_id,
            "parameter_code": p.parameter_code,
            "parameter_name": p.parameter_name,
            "uom_name": p.uom_name,
            "data_type": p.data_type,
            "decimal_place": p.decimal_place,
            "parameter_category": p.parameter_category,
        }
        for p in rows
    ]


# ========== /admin/ir-devices ==========
# T-S11C-001 AC 4 (M-PM-074 §3.2; M-PM-083 §3 confirmed)
# IR device list（從 trx_reading device_id LIKE '811c_%' DISTINCT；T-P10-011 cutover phase9.1 後可用）
# + ems_ir_device_metadata LEFT JOIN 取 display_name
# 不註冊 ems_device（DR-028-05 多 edge 模板化暴力假設；trx_reading 為天然 register）

@router.get("/ir-devices")
async def list_ir_devices(db: AsyncSession = Depends(get_db)):
    """List all 811C IR devices with metadata.

    Source: trx_reading DISTINCT device_id LIKE '811c_%' (V2-final per-device cutover)
    + LEFT JOIN ems_ir_device_metadata for display_name.

    Returns: [{device_id, display_name (nullable), last_seen}]
    """
    result = await db.execute(text("""
        SELECT
          t.device_id,
          m.display_name,
          MAX(t.ts) AS last_seen
        FROM trx_reading t
        LEFT JOIN ems_ir_device_metadata m ON m.device_id = t.device_id
        WHERE t.device_id LIKE '811c_%'
        GROUP BY t.device_id, m.display_name
        ORDER BY t.device_id
    """))
    return [
        {
            "device_id": row[0],
            "display_name": row[1],
            "last_seen": row[2].isoformat() if row[2] else None,
        }
        for row in result.fetchall()
    ]


@router.put("/ir-devices/{device_id}/label")
async def upsert_ir_label(
    device_id: str,
    body: dict[str, Any] = Body(...),
    db: AsyncSession = Depends(get_db),
):
    """Upsert IR device label (display_name).

    Body: {"display_name": str}  (nullable; "" 視為清除)

    Returns: {device_id, display_name, updated_at}
    """
    display_name = body.get("display_name")
    if display_name is not None and not isinstance(display_name, str):
        raise HTTPException(status_code=422, detail="display_name must be string or null")

    # 守門：device_id 必須以 '811c_' 起頭（避免污染表）
    if not device_id.startswith("811c_"):
        raise HTTPException(
            status_code=422,
            detail=f"device_id must start with '811c_'; got: {device_id}"
        )

    await db.execute(text("""
        INSERT INTO ems_ir_device_metadata (device_id, display_name, updated_at)
        VALUES (:device_id, :display_name, NOW())
        ON CONFLICT (device_id) DO UPDATE
        SET display_name = EXCLUDED.display_name,
            updated_at = NOW()
    """), {"device_id": device_id, "display_name": display_name})

    await db.commit()

    result = await db.execute(text("""
        SELECT device_id, display_name, updated_at
        FROM ems_ir_device_metadata
        WHERE device_id = :device_id
    """), {"device_id": device_id})
    row = result.fetchone()
    return {
        "device_id": row[0],
        "display_name": row[1],
        "updated_at": row[2].isoformat() if row[2] else None,
    }
