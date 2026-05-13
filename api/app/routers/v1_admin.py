"""V2-final Admin router (ADR-026) — UI 管理 device / edge / ecsu / billing / model.

精簡成 5 組 CRUD，取代 16 個 fnd_* 舊 endpoint。
每次改動 device 相關即 bump 對應 edge.config_version 觸發 Edge pull。
"""

from __future__ import annotations

import json
from typing import Any, Dict, List

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from pydantic import BaseModel
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
from app.services import command_service, config_service
from app.services.wakeup_service import send_wakeup

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


# M-PM-166 fix: 補 PUT /edges/{edge_id} edit hostname / edge_name / site_code 等
# 對齊 M-PM-151 PUT/PATCH 雙 decorator pattern (admin-ui frontend 用 PUT method)
# 既有 PATCH 也加（向下相容；如其他 caller 用 PATCH）
_EDGE_ALLOWED_FIELDS = {
    "edge_name",      # display name
    "hostname",       # 機殼主機名 (老王要改的)
    "site_code",      # 站點代碼
    "remark_desc",    # 備註
}
# 不允許改：edge_id (PK) / token_hash / fingerprint / previous_fingerprints / status /
# config_version / last_seen_* / registered_at / approved_at / maintenance_at / replaced_at /
# revoked_at / approved_by — 走 enroll/approve/heartbeat 流程，非 admin-mutable


# M-PM-166 重新採證（5/8 12:50）：admin-ui frontend 實際走的是 PATCH /edge-credentials/{id}/hostname
# 不是我先前修的 PATCH /edges/{id}（M-P12-037 generic 端點仍保留向下相容）
# legacy admin.py 有此 route 但用 V1 schema (ems_edge_credential) + main.py 未掛
# 此 endpoint 為 V2 對齊版（UPDATE ems_edge.hostname）

class _RenameEdgeBody(BaseModel):
    hostname: str


@router.patch("/edge-credentials/{edge_id}/hostname")
async def rename_edge_hostname(
    edge_id: str,
    body: _RenameEdgeBody,
    db: AsyncSession = Depends(get_db),
):
    """修改 Edge 的主機名稱（ems_edge.hostname）— admin-ui frontend 實際呼叫路徑.

    M-PM-166 P1 fix（hostname 405 修通；admin-ui Edge 管理頁編輯主機名解封）。
    """
    new_name = (body.hostname or "").strip()
    if not new_name:
        raise HTTPException(status_code=400, detail="hostname 不可為空")

    edge = await db.get(EmsEdge, edge_id)
    if not edge:
        raise HTTPException(status_code=404, detail=f"edge {edge_id} not found")

    edge.hostname = new_name
    db.add(EmsEvent(
        event_kind="operation",
        severity="info",
        edge_id=edge_id,
        actor="admin",
        message=f"edge hostname renamed",
        data_json={"hostname": new_name},
    ))
    await db.commit()
    return {"status": "ok", "edge_id": edge_id, "hostname": new_name}


@router.put("/edges/{edge_id}")
@router.patch("/edges/{edge_id}")
async def update_edge(
    edge_id: str,
    body: dict[str, Any] = Body(...),
    db: AsyncSession = Depends(get_db),
):
    """編輯 Edge admin-mutable 欄位（hostname / edge_name / site_code / remark_desc）.

    M-PM-166 P1 fix（HTTP 405 修通；admin-ui Edge 管理頁編輯主機名解封）。

    Args:
        edge_id: 目標 Edge
        body: 含可改欄位（多欄位一次更新）
    """
    edge = await db.get(EmsEdge, edge_id)
    if not edge:
        raise HTTPException(status_code=404, detail=f"edge {edge_id} not found")

    # 過濾合法欄位
    update_fields = {k: v for k, v in body.items() if k in _EDGE_ALLOWED_FIELDS}
    if not update_fields:
        raise HTTPException(
            status_code=400,
            detail=f"no valid fields to update; allowed: {sorted(_EDGE_ALLOWED_FIELDS)}",
        )

    for k, v in update_fields.items():
        setattr(edge, k, v)

    db.add(EmsEvent(
        event_kind="operation",
        severity="info",
        edge_id=edge_id,
        actor=body.get("actor", "admin"),
        message=f"edge updated: {sorted(update_fields.keys())}",
        data_json=body,
    ))
    await db.commit()

    return {
        "status": "updated",
        "edge_id": edge_id,
        "updated_fields": sorted(update_fields.keys()),
    }


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


# ========== Scan Confirm — 批次建立設備 + 下發 device.configure ==========
# M-PM-148 fix: v1_admin.py 缺 /edges/{edge_id}/devices/confirm endpoint
# 從 legacy admin.py（main.py 未掛載）遷入 + V2 schema 對齊（device_kind='modbus_meter')

# device_type → device_kind mapping（V2 schema CHECK constraint 限定值）
_DEVICE_KIND_MAP = {
    "cpm12d": "modbus_meter",
    "cpm23": "modbus_meter",
    "aem_drb": "modbus_meter",
    "tcs300b03": "modbus_meter",
}


class ConfirmCircuit(BaseModel):
    circuit: str
    ct_pri: int = 0
    wire: str = ""


class ConfirmDevice(BaseModel):
    device_id: str
    device_type: str  # frontend 命名（cpm12d/cpm23/aem_drb 等）；給 Edge active_devices.json 用
    device_name: str = ""
    slave_id: int
    bus_id: str
    circuits: List[ConfirmCircuit] = []


class ConfirmDevicesRequest(BaseModel):
    devices: List[ConfirmDevice]


@router.post("/edges/{edge_id}/devices/confirm")
async def confirm_devices(
    edge_id: str,
    body: ConfirmDevicesRequest,
    db: AsyncSession = Depends(get_db),
):
    """Batch-create ems_device records + issue device.configure to Edge.

    對齊 V2-final schema:
    - ems_device.device_kind: CHECK ∈ ('modbus_meter','thermal','relay','bacnet','other')
      → frontend device_type ('cpm12d' 等) → mapped to 'modbus_meter'
    - 完整 device_type 字串保留在 device.configure command payload（Edge dispatch 用）

    M-PM-148 P0 fix（HTTP 405 修通；ScanWizard Step 3 確認建立解封）。
    """
    if not body.devices:
        raise HTTPException(status_code=400, detail="No devices to confirm")

    # 1. Batch insert ems_device (ON CONFLICT DO NOTHING for idempotency)
    #    + ems_device_modbus 子表（M-P12-034 補；admin-ui list 需 slave_id 等細節）
    created_count = 0
    for dev in body.devices:
        device_kind = _DEVICE_KIND_MAP.get(dev.device_type, "other")
        result = await db.execute(
            text("""
                INSERT INTO ems_device (device_id, edge_id, device_kind, display_name)
                VALUES (:device_id, :edge_id, :device_kind, :display_name)
                ON CONFLICT (device_id) DO NOTHING
            """),
            {
                "device_id": dev.device_id,
                "edge_id": edge_id,
                "device_kind": device_kind,
                "display_name": dev.device_name or f"{dev.device_type}-{edge_id}-slave{dev.slave_id}",
            },
        )
        created_count += result.rowcount or 0

        # Modbus 子表：所有現支援 device_type (cpm12d/cpm23/aem_drb/tcs300b03) 都走 RTU
        # M-PM-129 4-16 落案：AEM_DRB TCP 棄用全 RTU；對齊 v11_main.py dispatch
        if device_kind == "modbus_meter":
            await db.execute(
                text("""
                    INSERT INTO ems_device_modbus
                        (device_id, slave_id, bus_id, transport, poll_interval_sec)
                    VALUES
                        (:device_id, :slave_id, :bus_id, 'rtu', 30)
                    ON CONFLICT (device_id) DO UPDATE
                    SET slave_id = EXCLUDED.slave_id,
                        bus_id = EXCLUDED.bus_id,
                        transport = EXCLUDED.transport
                """),
                {
                    "device_id": dev.device_id,
                    "slave_id": dev.slave_id,
                    "bus_id": dev.bus_id,
                },
            )
    await db.commit()

    # 2. Cleanup bootstrap placeholder（保留歷史 scan commands FK）
    placeholder_id = f"_scan-{edge_id}"
    first_real_id = body.devices[0].device_id
    if first_real_id != placeholder_id:
        await db.execute(
            text("UPDATE ems_commands SET device_id = :new_id WHERE device_id = :placeholder"),
            {"new_id": first_real_id, "placeholder": placeholder_id},
        )
    await db.execute(
        text("DELETE FROM ems_device WHERE device_id = :placeholder AND edge_id = :edge_id"),
        {"placeholder": placeholder_id, "edge_id": edge_id},
    )
    await db.commit()

    # 3. Build device.configure payload — 完整 snapshot（Edge 全量覆寫 active_devices.json）
    existing_map: Dict[str, Dict[str, Any]] = {}
    rows = await db.execute(
        text("""
            SELECT payload_json FROM ems_commands
            WHERE command_type = 'device.configure'
              AND status = 'SUCCEEDED'
              AND device_id IN (SELECT device_id FROM ems_device WHERE edge_id = :edge_id)
            ORDER BY updated_at DESC
        """),
        {"edge_id": edge_id},
    )
    for (payload,) in rows.fetchall():
        if isinstance(payload, str):
            payload = json.loads(payload)
        for d in (payload or {}).get("devices", []):
            code = d.get("device_code")
            if code and code not in existing_map:
                existing_map[code] = d

    # 本次 body.devices 覆蓋既有
    for dev in body.devices:
        active_circuits: Dict[str, Dict[str, Any]] = {}
        for c in dev.circuits:
            active_circuits[c.circuit] = {
                "ct_pri": c.ct_pri,
                "wire": c.wire,
                "label": "",
            }
        existing_map[dev.device_id] = {
            "device_code": dev.device_id,
            "device_type": dev.device_type,  # 保留 frontend 命名給 Edge
            "slave_id": dev.slave_id,
            "bus_id": dev.bus_id,
            "active_circuits": active_circuits,
        }

    # 過濾 placeholder + 已刪除設備
    valid_rows = await db.execute(
        text("SELECT device_id FROM ems_device WHERE edge_id = :edge_id"),
        {"edge_id": edge_id},
    )
    valid_ids = {r[0] for r in valid_rows.fetchall() if not r[0].startswith("_")}
    configure_devices = [d for code, d in existing_map.items() if code in valid_ids]

    # 4. Issue device.configure command
    configure_command_id = await command_service.create_command(
        db=db,
        edge_id=edge_id,
        device_id=body.devices[0].device_id,
        command_type="device.configure",
        payload={"devices": configure_devices},
        priority=0,
        idempotency_key=None,
        issued_by="admin-ui",
    )

    # 5. MQTT wake-up（non-fatal）
    try:
        send_wakeup(edge_id=edge_id)
    except Exception:
        pass

    return {
        "created_count": created_count,
        "command_id": configure_command_id,
    }


# ========== Edge-scoped device listing (admin-ui Edges 頁展開用) ==========
# M-PM-150 fix: admin-ui 呼叫 GET /v1/admin/edges/{edge_id}/devices 但 endpoint 缺實作
# → 404；本 endpoint 含 modbus + thermal 子表 LEFT JOIN；filter placeholder

@router.get("/edges/{edge_id}/devices")
async def list_edge_devices(
    edge_id: str,
    include_placeholder: bool = False,
    db: AsyncSession = Depends(get_db),
):
    """查某 Edge 下所有設備清單（含 modbus + thermal 子表 metadata）.

    Args:
        edge_id: 目標 Edge
        include_placeholder: 是否含 `_placeholder_*` row（admin-ui 預設不顯示）

    Returns:
        [{ device_id, edge_id, device_kind, display_name, enabled, config_version,
           model_id, modbus: {...}|null, thermal: {...}|null }, ...]
    """
    # 確認 edge 存在
    edge = await db.get(EmsEdge, edge_id)
    if not edge:
        raise HTTPException(status_code=404, detail=f"edge {edge_id} not found")

    stmt = select(EmsDevice).where(
        EmsDevice.edge_id == edge_id,
        EmsDevice.deleted_at.is_(None),
    )
    devices = (await db.execute(stmt)).scalars().all()

    if not include_placeholder:
        devices = [d for d in devices if not d.device_id.startswith("_")]

    result: list[dict[str, Any]] = []
    for dev in devices:
        item: dict[str, Any] = {
            "device_id": dev.device_id,
            "edge_id": dev.edge_id,
            "device_kind": dev.device_kind,
            "display_name": dev.display_name,
            "model_id": dev.model_id,
            "enabled": dev.enabled,
            "config_version": dev.config_version,
            # M-PM-154 supplement: 補 created_at / updated_at（admin-ui Edge 管理頁「建立時間」欄）
            "created_at": dev.created_at.isoformat() if dev.created_at else None,
            "updated_at": dev.updated_at.isoformat() if dev.updated_at else None,
            "modbus": None,
            "thermal": None,
        }

        # Modbus 子表（modbus_meter 設備）
        if dev.device_kind == "modbus_meter":
            mb = await db.get(EmsDeviceModbus, dev.device_id)
            if mb:
                item["modbus"] = {
                    "slave_id": mb.slave_id,
                    "bus_id": mb.bus_id,
                    "transport": mb.transport,
                    "tcp_host": mb.tcp_host,
                    "tcp_port": mb.tcp_port,
                    "poll_interval_sec": mb.poll_interval_sec,
                    "endianness": mb.endianness,
                }

        # Thermal 子表（thermal 設備）
        if dev.device_kind == "thermal":
            th = await db.get(EmsDeviceThermal, dev.device_id)
            if th:
                # 動態抓所有欄位（避免 schema 變動 break）
                item["thermal"] = {
                    c.name: getattr(th, c.name)
                    for c in th.__table__.columns
                    if c.name != "device_id"
                }

        result.append(item)

    return {"edge_id": edge_id, "devices": result, "count": len(result)}


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
            # T-AdminUI-001 補（M-PM-207；對齊 V1 path GET /admin/edges/{id}/devices M-PM-154 pattern）
            "created_at": d.created_at.isoformat() if d.created_at else None,
            "updated_at": d.updated_at.isoformat() if d.updated_at else None,
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


# M-PM-151 fix: 加 PUT 同實作（admin-ui frontend 用 PUT method；既有 PATCH 保留向下相容）
@router.put("/devices/{device_id}")
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


# M-PM-217 Phase A：補 PUT + DELETE（業主 5/12 PUT 405 阻塞修；4/18 G1 預警兌現）

_ECSU_ALLOWED_FIELDS = {
    "ecsu_code", "ecsu_name", "parent_id", "display_seq", "enabled", "remark_desc"
}


@router.put("/ecsu/{ecsu_id}")
@router.patch("/ecsu/{ecsu_id}")
async def update_ecsu(
    ecsu_id: int,
    body: dict[str, Any] = Body(...),
    db: AsyncSession = Depends(get_db),
):
    """編輯 ECSU 主欄位（ecsu_code / ecsu_name / parent_id / display_seq / enabled / remark_desc）.

    M-PM-217 Phase A 業主 P0 阻塞修（5/12 19:30 chat curl PUT 405）.
    對齊 M-PM-151 / M-PM-166 device/edge PUT+PATCH 雙 decorator pattern。
    """
    row = await db.get(FndEcsu, ecsu_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"ecsu_id {ecsu_id} not found")

    update_fields = {k: v for k, v in body.items() if k in _ECSU_ALLOWED_FIELDS}
    if not update_fields:
        raise HTTPException(
            status_code=400,
            detail=f"no valid fields to update; allowed: {sorted(_ECSU_ALLOWED_FIELDS)}",
        )

    for k, v in update_fields.items():
        setattr(row, k, v)

    db.add(EmsEvent(
        event_kind="operation",
        severity="info",
        actor=body.get("actor", "admin"),
        message=f"ecsu updated: {sorted(update_fields.keys())}",
        data_json={"ecsu_id": ecsu_id, **body},
    ))
    await db.commit()
    await db.refresh(row)

    return {
        "status": "updated",
        "ecsu_id": row.ecsu_id,
        "ecsu_code": row.ecsu_code,
        "ecsu_name": row.ecsu_name,
        "parent_id": row.parent_id,
        "display_seq": row.display_seq,
        "enabled": row.enabled,
        "remark_desc": row.remark_desc,
        "updated_fields": sorted(update_fields.keys()),
    }


@router.delete("/ecsu/{ecsu_id}")
async def delete_ecsu(
    ecsu_id: int,
    db: AsyncSession = Depends(get_db),
):
    """刪除 ECSU（hard delete；fnd_ecsu schema 無 deleted_at；CASCADE 清 circuit_assgn）.

    M-PM-217 Phase A 業主 P0 阻塞修。
    fnd_ecsu_circuit_assgn FK ON DELETE CASCADE → 子表自動清。
    """
    row = await db.get(FndEcsu, ecsu_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"ecsu_id {ecsu_id} not found")

    # 採證：是否有 child ECSU 指向本 row 為 parent
    child_count = (await db.execute(
        select(FndEcsu).where(FndEcsu.parent_id == ecsu_id)
    )).scalars().all()
    if child_count:
        raise HTTPException(
            status_code=409,
            detail=f"ecsu_id {ecsu_id} has {len(child_count)} child ECSU; reassign or delete children first",
        )

    db.add(EmsEvent(
        event_kind="operation",
        severity="info",
        actor="admin",
        message="ecsu deleted",
        data_json={"ecsu_id": ecsu_id, "ecsu_code": row.ecsu_code, "ecsu_name": row.ecsu_name},
    ))
    await db.delete(row)
    await db.commit()
    return {"status": "deleted", "ecsu_id": ecsu_id}


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


# ========== M-PM-217 Phase B：多對多綁定 CRUD（4 endpoints）==========

_ASSGN_ALLOWED_FIELDS = {"sign", "enabled", "remark_desc"}


@router.get("/ecsu/{ecsu_id}/circuits")
async def list_ecsu_circuits(
    ecsu_id: int,
    db: AsyncSession = Depends(get_db),
):
    """列某 ECSU 綁定的所有電路（多對多）.

    DB 真實 schema: sign (-1/1) + enabled (替代 PM 信寫的 assignment_type ENUM)
    """
    ecsu = await db.get(FndEcsu, ecsu_id)
    if ecsu is None:
        raise HTTPException(status_code=404, detail=f"ecsu_id {ecsu_id} not found")

    rows = (await db.execute(
        select(FndEcsuCircuitAssgn).where(FndEcsuCircuitAssgn.ecsu_id == ecsu_id)
    )).scalars().all()

    return {
        "ecsu_id": ecsu_id,
        "ecsu_code": ecsu.ecsu_code,
        "ecsu_name": ecsu.ecsu_name,
        "circuits": [
            {
                "assgn_id": r.assgn_id,
                "device_id": r.device_id,
                "circuit_code": r.circuit_code,
                "sign": r.sign,
                "enabled": r.enabled,
                "remark_desc": r.remark_desc,
            }
            for r in rows
        ],
        "count": len(rows),
    }


@router.post("/ecsu/{ecsu_id}/circuits")
async def create_ecsu_circuit(
    ecsu_id: int,
    body: dict[str, Any] = Body(...),
    db: AsyncSession = Depends(get_db),
):
    """新增 ECSU 電路綁定.

    body required: device_id (str), circuit_code (str)
    body optional: sign (int -1/1; default 1), enabled (bool; default True), remark_desc (str)
    """
    ecsu = await db.get(FndEcsu, ecsu_id)
    if ecsu is None:
        raise HTTPException(status_code=404, detail=f"ecsu_id {ecsu_id} not found")

    device_id = body.get("device_id")
    circuit_code = body.get("circuit_code")
    if not device_id or not circuit_code:
        raise HTTPException(status_code=422, detail="device_id and circuit_code required")

    sign = body.get("sign", 1)
    if sign not in (-1, 1):
        raise HTTPException(status_code=422, detail="sign must be -1 or 1 (chk_assgn_sign)")

    # device_id 必須存在於 ems_device
    dev = await db.get(EmsDevice, device_id)
    if dev is None:
        raise HTTPException(status_code=404, detail=f"device_id {device_id} not found")

    assgn = FndEcsuCircuitAssgn(
        ecsu_id=ecsu_id,
        device_id=device_id,
        circuit_code=circuit_code,
        sign=sign,
        enabled=body.get("enabled", True),
        remark_desc=body.get("remark_desc"),
    )
    db.add(assgn)
    try:
        await db.commit()
    except Exception as e:
        await db.rollback()
        raise HTTPException(
            status_code=409,
            detail=f"conflict: UNIQUE(ecsu_id, device_id, circuit_code) — {type(e).__name__}",
        )
    await db.refresh(assgn)

    db.add(EmsEvent(
        event_kind="operation",
        severity="info",
        device_id=device_id,
        actor=body.get("actor", "admin"),
        message=f"ecsu circuit bound: ecsu={ecsu_id} dev={device_id} circuit={circuit_code} sign={sign}",
        data_json=body,
    ))
    await db.commit()

    return {
        "status": "created",
        "assgn_id": assgn.assgn_id,
        "ecsu_id": ecsu_id,
        "device_id": device_id,
        "circuit_code": circuit_code,
        "sign": sign,
        "enabled": assgn.enabled,
    }


@router.patch("/ecsu/circuits/{assgn_id}")
async def update_ecsu_circuit(
    assgn_id: int,
    body: dict[str, Any] = Body(...),
    db: AsyncSession = Depends(get_db),
):
    """更新 ECSU 電路綁定屬性 (sign / enabled / remark_desc).

    不允許改：assgn_id (PK) / ecsu_id / device_id / circuit_code（要改改 ID 等於重建；應 DELETE + POST）
    """
    assgn = await db.get(FndEcsuCircuitAssgn, assgn_id)
    if assgn is None:
        raise HTTPException(status_code=404, detail=f"assgn_id {assgn_id} not found")

    update_fields = {k: v for k, v in body.items() if k in _ASSGN_ALLOWED_FIELDS}
    if not update_fields:
        raise HTTPException(
            status_code=400,
            detail=f"no valid fields; allowed: {sorted(_ASSGN_ALLOWED_FIELDS)}",
        )

    if "sign" in update_fields and update_fields["sign"] not in (-1, 1):
        raise HTTPException(status_code=422, detail="sign must be -1 or 1")

    for k, v in update_fields.items():
        setattr(assgn, k, v)

    db.add(EmsEvent(
        event_kind="operation",
        severity="info",
        device_id=assgn.device_id,
        actor=body.get("actor", "admin"),
        message=f"ecsu circuit updated: assgn={assgn_id} fields={sorted(update_fields.keys())}",
        data_json={"assgn_id": assgn_id, **body},
    ))
    await db.commit()

    return {
        "status": "updated",
        "assgn_id": assgn_id,
        "updated_fields": sorted(update_fields.keys()),
    }


@router.delete("/ecsu/circuits/{assgn_id}")
async def delete_ecsu_circuit(
    assgn_id: int,
    db: AsyncSession = Depends(get_db),
):
    """移除 ECSU 電路綁定."""
    assgn = await db.get(FndEcsuCircuitAssgn, assgn_id)
    if assgn is None:
        raise HTTPException(status_code=404, detail=f"assgn_id {assgn_id} not found")

    db.add(EmsEvent(
        event_kind="operation",
        severity="info",
        device_id=assgn.device_id,
        actor="admin",
        message=f"ecsu circuit unbound: assgn={assgn_id} ecsu={assgn.ecsu_id} dev={assgn.device_id}",
        data_json={"assgn_id": assgn_id, "ecsu_id": assgn.ecsu_id, "device_id": assgn.device_id},
    ))
    await db.delete(assgn)
    await db.commit()
    return {"status": "deleted", "assgn_id": assgn_id}


# ========== M-PM-217 Phase C：聚合查詢（2 endpoints）==========


@router.get("/ecsu/{ecsu_id}/realtime")
async def ecsu_realtime(
    ecsu_id: int,
    db: AsyncSession = Depends(get_db),
):
    """即時用電聚合 — SUM(sign × latest power_total) over enabled bindings.

    對齊 DB 真實 schema：sign (-1/1) 替代 PM 信寫的 assignment_type；
    enabled 替代 valid_from/to；parameter_code='power_total' 替代 power_kw column.
    """
    ecsu = await db.get(FndEcsu, ecsu_id)
    if ecsu is None:
        raise HTTPException(status_code=404, detail=f"ecsu_id {ecsu_id} not found")

    sql = """
        SELECT COALESCE(SUM(a.sign * r.latest_power), 0) AS realtime_kw,
               COUNT(DISTINCT a.assgn_id) AS active_bindings
        FROM fnd_ecsu_circuit_assgn a
        LEFT JOIN LATERAL (
            SELECT value AS latest_power
            FROM trx_reading
            WHERE device_id = a.device_id
              AND circuit_code = a.circuit_code
              AND parameter_code = 'power_total'
              AND ts > NOW() - INTERVAL '5 minutes'
            ORDER BY ts DESC
            LIMIT 1
        ) r ON true
        WHERE a.ecsu_id = :ecsu_id
          AND a.enabled = TRUE
    """
    row = (await db.execute(text(sql), {"ecsu_id": ecsu_id})).fetchone()

    return {
        "ecsu_id": ecsu_id,
        "ecsu_code": ecsu.ecsu_code,
        "ecsu_name": ecsu.ecsu_name,
        "realtime_kw": float(row[0]) if row and row[0] is not None else 0.0,
        "active_bindings": int(row[1]) if row and row[1] is not None else 0,
        "window": "5min",
        "parameter_code": "power_total",
    }


@router.get("/ecsu/{ecsu_id}/monthly")
async def ecsu_monthly(
    ecsu_id: int,
    db: AsyncSession = Depends(get_db),
):
    """本月累積 kWh — 用 energy_kwh_imp 累積值差 (last - first) over month window.

    對齊 DB 真實 schema：parameter_code='energy_kwh_imp' 累積能量 (kWh)
    用 last - first 取月內累積差 (比 power × time 積分簡單且精準)
    """
    ecsu = await db.get(FndEcsu, ecsu_id)
    if ecsu is None:
        raise HTTPException(status_code=404, detail=f"ecsu_id {ecsu_id} not found")

    sql = """
        SELECT COALESCE(SUM(a.sign * COALESCE(r.kwh_delta, 0)), 0) AS monthly_kwh,
               COUNT(DISTINCT a.assgn_id) AS active_bindings
        FROM fnd_ecsu_circuit_assgn a
        LEFT JOIN LATERAL (
            SELECT MAX(value) - MIN(value) AS kwh_delta
            FROM trx_reading
            WHERE device_id = a.device_id
              AND circuit_code = a.circuit_code
              AND parameter_code = 'energy_kwh_imp'
              AND ts >= date_trunc('month', NOW())
        ) r ON true
        WHERE a.ecsu_id = :ecsu_id
          AND a.enabled = TRUE
    """
    row = (await db.execute(text(sql), {"ecsu_id": ecsu_id})).fetchone()

    return {
        "ecsu_id": ecsu_id,
        "ecsu_code": ecsu.ecsu_code,
        "ecsu_name": ecsu.ecsu_name,
        "monthly_kwh": float(row[0]) if row and row[0] is not None else 0.0,
        "active_bindings": int(row[1]) if row and row[1] is not None else 0,
        "window": "month_to_date",
        "parameter_code": "energy_kwh_imp",
    }


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
