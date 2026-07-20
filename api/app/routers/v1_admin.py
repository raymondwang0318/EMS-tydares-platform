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
from app.services import config_service
from app.services.wakeup_service import send_wakeup
from app.constants.device_circuits import (
    DEVICE_MODEL_CIRCUITS,
    get_circuits,
    map_circuit_to_energy_param,
    map_circuit_to_power_param,
    map_circuit_to_voltage_ll_param,
    map_circuit_to_voltage_param,
    map_circuit_to_wire_param,
    wire_value_means_ll_only,
    wire_value_name,
)

router = APIRouter(prefix="/v1/admin", tags=["admin"], dependencies=[Depends(verify_admin_token)])


# ============================================================================
# M-PM-237 Phase D: ECSU 聚合 5 sec TTL in-mem cache（單 worker；多 worker 轉 Redis）
# ============================================================================

import time as _time

_ECSU_CACHE_TTL_SEC = 5.0
_ecsu_cache: dict[tuple[str, int], tuple[float, dict[str, Any]]] = {}


def _cache_get(kind: str, ecsu_id: int) -> dict[str, Any] | None:
    key = (kind, ecsu_id)
    entry = _ecsu_cache.get(key)
    if entry is None:
        return None
    ts, value = entry
    if _time.time() - ts > _ECSU_CACHE_TTL_SEC:
        _ecsu_cache.pop(key, None)
        return None
    return value


def _cache_put(kind: str, ecsu_id: int, value: dict[str, Any]) -> None:
    _ecsu_cache[(kind, ecsu_id)] = (_time.time(), value)


def _cache_invalidate(ecsu_id: int) -> None:
    """業務變更時清 cache（POST/PATCH/DELETE /circuits）."""
    _ecsu_cache.pop(("realtime", ecsu_id), None)
    _ecsu_cache.pop(("monthly", ecsu_id), None)


def _cache_invalidate_all() -> None:
    """全清（test/debug 用）."""
    _ecsu_cache.clear()


# ========== /admin/edges ==========

@router.get("/edges")
async def list_edges(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(EmsEdge).order_by(EmsEdge.edge_id))).scalars().all()
    # edge 核心溫度（M-PM-306 衍生 Phase 2）：帶出各 edge 最新 CPU 溫度
    # （ems_edge_heartbeat.payload_json.cpu_temp_c；edge_host_monitor 每 60s 寫入）
    temp_rows = (await db.execute(text("""
        SELECT DISTINCT ON (edge_id) edge_id,
               (payload_json->>'cpu_temp_c')::float AS cpu_temp_c,
               hb_ts
        FROM ems_edge_heartbeat
        WHERE payload_json ? 'cpu_temp_c'
        ORDER BY edge_id, hb_ts DESC
    """))).fetchall()
    temp_map = {
        r[0]: {"cpu_temp_c": r[1], "cpu_temp_at": r[2].isoformat() if r[2] else None}
        for r in temp_rows
    }
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
            "cpu_temp_c": temp_map.get(e.edge_id, {}).get("cpu_temp_c"),
            "cpu_temp_at": temp_map.get(e.edge_id, {}).get("cpu_temp_at"),
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
    # TCS300B03 DI（scanner 回 "tcs300b03_di"；舊 confirm 回 "tcs300b03"；兩者皆 map 到正確 kind）
    "tcs300b03": "tcs300b03_di",
    "tcs300b03_di": "tcs300b03_di",
    # TCS300B04 DO（scanner 回 "tcs300b04_do"；舊 confirm 回 "tcs300b04"；兩者皆 map 到正確 kind）
    "tcs300b04": "tcs300b04_do",
    "tcs300b04_do": "tcs300b04_do",
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

    # 1. Batch insert ems_device (ON CONFLICT 復活 soft-deleted row;M-PM-268 fix)
    #    + ems_device_modbus 子表（M-P12-034 補；admin-ui list 需 slave_id 等細節）
    #
    # M-PM-268 root cause: 原 ON CONFLICT DO NOTHING → 撞 soft-deleted row (deleted_at IS NOT NULL)
    # 時 row 不被 INSERT 也不被 UPDATE → admin-ui list 取 WHERE deleted_at IS NULL 永遠空.
    # 修: 改 DO UPDATE SET deleted_at=NULL 復活 + 更新 edge_id/kind/display_name
    # (5/18 既建 cpm12d-E07-slave7 5/22 soft-deleted → 5/25 業主重掃復活).
    created_count = 0
    for dev in body.devices:
        device_kind = _DEVICE_KIND_MAP.get(dev.device_type, "other")
        result = await db.execute(
            text("""
                INSERT INTO ems_device (device_id, edge_id, device_kind, display_name)
                VALUES (:device_id, :edge_id, :device_kind, :display_name)
                ON CONFLICT (device_id) DO UPDATE
                SET deleted_at = NULL,
                    edge_id     = EXCLUDED.edge_id,
                    device_kind = EXCLUDED.device_kind,
                    display_name = EXCLUDED.display_name,
                    updated_at  = NOW()
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
    #
    # M-P11-E06 修：原碼寫死 `_scan-{edge_id}` (舊命名)；ScanWizard 現用 `_placeholder_{hex}` (新命名)
    # → cleanup 永遠 0 row → 路徑 3 confirm 後 placeholder 殘留 (5/17 老王 E10 鐵證)
    # 修法：LIKE `_placeholder_%` 比對任何 hex 後綴；FK update 取該 edge 所有殘留 placeholder
    first_real_id = body.devices[0].device_id
    # FK保: 將 placeholder 上的 scan command 改指到第一個真實 device_id（避免孤兒 FK）
    await db.execute(
        text("""
            UPDATE ems_commands
            SET device_id = :new_id
            WHERE device_id LIKE '_placeholder_%'
              AND device_id IN (
                SELECT device_id FROM ems_device WHERE edge_id = :edge_id
              )
        """),
        {"new_id": first_real_id, "edge_id": edge_id},
    )
    # 軟刪該 edge 所有 placeholder（含本次 ScanWizard bootstrap + 任何歷史殘留）
    # 使用 soft_delete_device pattern：set deleted_at 而非 DELETE row (對齊 schema 既有設計)
    from datetime import datetime, timezone as tz
    await db.execute(
        text("""
            UPDATE ems_device
            SET deleted_at = :now
            WHERE device_id LIKE '_placeholder_%'
              AND edge_id = :edge_id
              AND deleted_at IS NULL
        """),
        {"now": datetime.now(tz.utc), "edge_id": edge_id},
    )
    await db.commit()

    # 3. Bump edge config_version — Edge 主動 pull /desired-config (ADR-026)
    #
    # M-PM-276 §一 fix (M-P12-067 §七.1 升報候選兌現):
    # 既有 step 3-4 build device.configure payload + 派 device.configure cmd 已 deprecated
    # (V2-final ADR-026: Edge 主動 pull /v1/edges/{id}/desired-config snapshot 取代 push cmd);
    # Edge 拒絕 device.configure cmd 回 FAILED 累積 ems_commands FAILED row + ems_events
    # command error log 沒實質效用.
    #
    # 改: 純 bump config_version → Edge 下次 pull /desired-config 拿全量 active_devices snapshot.
    # config_service.bump_edge_config_version 既有 helper (M-PM-148 之後 V2-final 既建模式).
    new_config_version = await config_service.bump_edge_config_version(db, edge_id)

    # 4. MQTT wake-up — 通知 Edge 立即 pull 新 config (non-fatal)
    try:
        send_wakeup(edge_id=edge_id)
    except Exception:
        pass

    return {
        "created_count": created_count,
        "edge_config_version": new_config_version,
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


# M-PM-241 §2.1: batch 清全部 placeholder（業主 5/19 明示「一鍵清除全部」UX）
# 註冊順序 IMPORTANT: 此 endpoint **必先** /devices/{device_id} 否則 FastAPI
# 會把 'placeholders' 誤匹配為 device_id 走 single delete route → 404
@router.delete("/devices/placeholders")
async def cleanup_placeholders(db: AsyncSession = Depends(get_db)):
    """一鍵清除全部 ScanWizard placeholder（device_id LIKE '_placeholder_%'）.

    M-PM-241 §2.1 業主 5/19 明示「一鍵清除全部掃描佔位」UX 補。
    對齊 M-PM-226 §三 transaction 雙保險 pattern（BEGIN → count before → DELETE → count=0 → COMMIT）.
    對齊 M-PM-227 ScanWizard rollback bug 修法既建（本卷補 UI gap；不擾 rollback 路徑）.
    """
    # 採證 before count + 清單（拿 device_id 給 audit log）
    rows = (await db.execute(text("""
        SELECT device_id, edge_id FROM ems_device
        WHERE device_id LIKE '_placeholder\\_%' ESCAPE '\\'
    """))).fetchall()
    deleted_devices = [{"device_id": r[0], "edge_id": r[1]} for r in rows]
    deleted_count = len(deleted_devices)

    if deleted_count > 0:
        # DELETE batch
        await db.execute(text("""
            DELETE FROM ems_device
            WHERE device_id LIKE '_placeholder\\_%' ESCAPE '\\'
        """))

        # audit log
        db.add(EmsEvent(
            event_kind="operation",
            severity="warn",
            actor="admin",
            message=f"batch cleanup placeholders: deleted {deleted_count} row(s)",
            data_json={"deleted_count": deleted_count, "deleted_devices": deleted_devices},
        ))

    await db.commit()

    # 採證 after count（雙保險；應 = 0）
    after_count = (await db.execute(text("""
        SELECT COUNT(*) FROM ems_device
        WHERE device_id LIKE '_placeholder\\_%' ESCAPE '\\'
    """))).scalar()

    return {
        "status": "cleaned",
        "deleted_count": deleted_count,
        "remaining_count": after_count,  # 應 = 0；雙保險 verify
        "deleted_devices": deleted_devices,
    }


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


# ========== /admin/devices/{device_id}/ecsu-bindings — M-PM-267 §二 ==========
# device → ECSU 反向查詢；解業主刪除電表前「91 ECSU 逐筆檢查」痛點


@router.get("/devices/{device_id}/ecsu-bindings")
async def get_device_ecsu_bindings(device_id: str, db: AsyncSession = Depends(get_db)):
    """列該 device 被哪些 ECSU 綁定（含 circuit_code + sign + enabled）.

    M-PM-267 §二：給 device_id 反查 fnd_ecsu_circuit_assgn × fnd_ecsu；
    用於刪除電表前對話框顯示「此設備被 N 個 ECSU 綁定：KW-XX·區域·名稱 ...」.

    回傳全部 binding（含 enabled=false 的歷史綁定;frontend 自決如何呈現）.
    一個 device 可有多個 circuit 各別 bind 不同 ECSU（spec 允許；現況 0 案例但保留邏輯）.

    Response:
        {
          "device_id": "aem_drb-TYDARES-E04-slave20",
          "bindings": [
            {
              "assgn_id": 3, "ecsu_id": 21, "ecsu_code": "KW-21",
              "ecsu_name": "P1B", "region": null,
              "circuit_code": "ba1", "sign": 1, "enabled": true,
              "remark_desc": null
            },
            ...
          ],
          "total": 1,
          "enabled_count": 1
        }
    """
    rows = (await db.execute(text("""
        SELECT a.assgn_id, a.ecsu_id, e.ecsu_code, e.ecsu_name, e.region,
               a.circuit_code, a.sign, a.enabled, a.remark_desc
        FROM fnd_ecsu_circuit_assgn a
        JOIN fnd_ecsu e ON e.ecsu_id = a.ecsu_id
        WHERE a.device_id = :device_id
        ORDER BY a.enabled DESC, e.ecsu_code, a.circuit_code
    """), {"device_id": device_id})).fetchall()

    bindings = [
        {
            "assgn_id": r[0],
            "ecsu_id": r[1],
            "ecsu_code": r[2],
            "ecsu_name": r[3],
            "region": r[4],
            "circuit_code": r[5],
            "sign": r[6],
            "enabled": r[7],
            "remark_desc": r[8],
        }
        for r in rows
    ]
    enabled_count = sum(1 for b in bindings if b["enabled"])

    return {
        "device_id": device_id,
        "bindings": bindings,
        "total": len(bindings),
        "enabled_count": enabled_count,
    }


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
            "region": e.region,  # M-PM-255 老王 5/21 拍板「區域加 ECSU 每筆欄位」
        }
        for e in rows
    ]


@router.post("/ecsu")
async def create_ecsu(body: dict[str, Any] = Body(...), db: AsyncSession = Depends(get_db)):
    row = FndEcsu(**{k: body[k] for k in body if k in {
        "ecsu_code", "ecsu_name", "parent_id", "display_seq", "enabled", "remark_desc",
        "region",  # M-PM-255
    }})
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return {"status": "created", "ecsu_id": row.ecsu_id}


# M-PM-217 Phase A：補 PUT + DELETE（業主 5/12 PUT 405 阻塞修；4/18 G1 預警兌現）

_ECSU_ALLOWED_FIELDS = {
    "ecsu_code", "ecsu_name", "parent_id", "display_seq", "enabled", "remark_desc",
    "region",  # M-PM-255
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
        "region": row.region,  # M-PM-255
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

    _cache_invalidate(ecsu_id)  # M-PM-237 Phase D: 業務變更清 cache

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

    _cache_invalidate(assgn.ecsu_id)  # M-PM-237 Phase D: 業務變更清 cache

    return {
        "status": "updated",
        "assgn_id": assgn_id,
        "ecsu_id": assgn.ecsu_id,
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

    invalidated_ecsu_id = assgn.ecsu_id  # 保留在 DELETE 前
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
    _cache_invalidate(invalidated_ecsu_id)  # M-PM-237 Phase D: 業務變更清 cache
    return {"status": "deleted", "assgn_id": assgn_id}


# ========== M-PM-217 Phase C：聚合查詢（2 endpoints）==========


@router.get("/ecsu/{ecsu_id}/realtime")
async def ecsu_realtime(
    ecsu_id: int,
    db: AsyncSession = Depends(get_db),
):
    """即時用電聚合 — SUM(sign × latest power per binding) over enabled bindings.

    M-PM-237 Phase B+C 重寫：mapping layer 對齊 driver 真實 parameter_code。

    Root cause C 修法：trx_reading.circuit_code 統一 'Ma'（driver flat 寫），
    放棄 JOIN circuit_code；改用 map_circuit_to_power_param() 算每個 binding 對應的
    parameter_code（aem_drb: ba1 → ba1_p / ba1-3 → ba1_3_p_sum；
    cpm23/cpm12d: → power_total）。

    Phase D：5 sec TTL in-mem cache；業務變更時 invalidate。
    """
    cached = _cache_get("realtime", ecsu_id)
    if cached is not None:
        return cached

    ecsu = await db.get(FndEcsu, ecsu_id)
    if ecsu is None:
        raise HTTPException(status_code=404, detail=f"ecsu_id {ecsu_id} not found")

    bindings = (await db.execute(
        select(FndEcsuCircuitAssgn).where(
            FndEcsuCircuitAssgn.ecsu_id == ecsu_id,
            FndEcsuCircuitAssgn.enabled == True,
        )
    )).scalars().all()

    total_kw = 0.0
    active = 0
    binding_details: list[dict[str, Any]] = []
    voltages: list[float] = []  # 電表存活參考；多綁定取 MAX 不平均（老王 2026-06-08）

    for b in bindings:
        param = map_circuit_to_power_param(b.circuit_code, b.device_id)
        latest = (await db.execute(text("""
            SELECT value FROM trx_reading
            WHERE device_id = :device_id
              AND parameter_code = :param_code
              AND ts > NOW() - INTERVAL '5 minutes'
            ORDER BY ts DESC LIMIT 1
        """), {"device_id": b.device_id, "param_code": param})).fetchone()

        value_w = float(latest[0]) if latest is not None and latest[0] is not None else None
        value_kw = (value_w / 1000.0) if value_w is not None else None

        if value_kw is not None:
            total_kw += b.sign * value_kw
            active += 1

        # 電壓取值（判斷電表存活參考）— M-PM-315 接線模式感知（老王 2026-06-10）：
        # 電表 sys_wire 設定採證欄已全 driver 輪詢上報 → 依「實際接線模式」決定電壓取
        # L-N（相）或 L-L（線）：3P3W 系（無中性線）相電壓物理上=0 非故障，取 L-L。
        # sys_wire 缺值時退回 zero-fallback（L-N>0 用 L-N，否則 L-L）。
        # 窗 10 分鐘：cpm23/aem_drb 輪詢 300s，5 分鐘窗會漏拍。
        vparam = map_circuit_to_voltage_param(b.circuit_code, b.device_id)
        llparam = map_circuit_to_voltage_ll_param(b.circuit_code, b.device_id)
        wparam = map_circuit_to_wire_param(b.circuit_code, b.device_id)
        params_in = tuple({p for p in (vparam, llparam, wparam) if p})
        vrows = (await db.execute(text("""
            SELECT DISTINCT ON (parameter_code) parameter_code, value
            FROM trx_reading
            WHERE device_id = :device_id
              AND parameter_code = ANY(:params)
              AND ts > NOW() - INTERVAL '10 minutes'
            ORDER BY parameter_code, ts DESC
        """), {"device_id": b.device_id, "params": list(params_in)})).fetchall()
        vmap = {r[0]: float(r[1]) for r in vrows if r[1] is not None}
        v_ln = vmap.get(vparam)
        v_ll = vmap.get(llparam)
        wire_raw = vmap.get(wparam) if wparam else None
        wire_val = int(wire_raw) if wire_raw is not None else None
        wire_ll = wire_val is not None and wire_value_means_ll_only(b.device_id, wire_val)

        def _src(p: str) -> str:
            return "L-L" if ("ll" in p or "_u_avg" in p) else "L-N"

        if wire_ll and v_ll is not None:
            v_val, v_src = v_ll, _src(llparam)          # 接線感知：3P3W 系 → 線電壓
        elif v_ln is not None and v_ln > 0:
            v_val, v_src = v_ln, _src(vparam)           # 型號預設電壓參數
        elif v_ll is not None and v_ll > 0:
            v_val, v_src = v_ll, _src(llparam)          # zero-fallback（sys_wire 未到時）
        else:
            v_val, v_src = v_ln, (_src(vparam) if v_ln is not None else None)
        if v_val is not None:
            voltages.append(v_val)

        binding_details.append({
            "assgn_id": b.assgn_id,
            "device_id": b.device_id,
            "circuit_code": b.circuit_code,
            "parameter_code": param,
            "sign": b.sign,
            "value_kw": value_kw,
            "voltage": v_val,
            "voltage_source": v_src,  # 'L-N' 相電壓 / 'L-L' 線電壓
            "sys_wire": wire_val,     # 電表自報接線模式原始值（設定採證）
            "wire_mode": wire_value_name(b.device_id, wire_val) if wire_val is not None else None,
        })

    result = {
        "ecsu_id": ecsu_id,
        "ecsu_code": ecsu.ecsu_code,
        "ecsu_name": ecsu.ecsu_name,
        "realtime_kw": total_kw,
        "voltage_max": max(voltages) if voltages else None,  # 多綁定取最高電壓（不平均）；電表存活參考
        "active_bindings": active,
        "total_bindings": len(bindings),
        "window": "5min",
        "bindings": binding_details,
        "cached": False,
    }
    _cache_put("realtime", ecsu_id, {**result, "cached": True})
    return result


@router.get("/ecsu/{ecsu_id}/monthly")
async def ecsu_monthly(
    ecsu_id: int,
    db: AsyncSession = Depends(get_db),
):
    """本月累積 kWh — 用 last - first 累積能量差 over month-to-date window.

    M-PM-237 Phase B+C 重寫：mapping layer 對齊 driver 真實 parameter_code
    （aem_drb: ba1 → ba1_ae_imp / ba1-3 → ba1_3_ae_imp；cpm23/cpm12d → energy_kwh_imp）

    Phase D：5 sec TTL in-mem cache。
    """
    cached = _cache_get("monthly", ecsu_id)
    if cached is not None:
        return cached

    ecsu = await db.get(FndEcsu, ecsu_id)
    if ecsu is None:
        raise HTTPException(status_code=404, detail=f"ecsu_id {ecsu_id} not found")

    bindings = (await db.execute(
        select(FndEcsuCircuitAssgn).where(
            FndEcsuCircuitAssgn.ecsu_id == ecsu_id,
            FndEcsuCircuitAssgn.enabled == True,
        )
    )).scalars().all()

    total_kwh = 0.0
    active = 0
    binding_details: list[dict[str, Any]] = []

    for b in bindings:
        param = map_circuit_to_energy_param(b.circuit_code, b.device_id)
        row_d = (await db.execute(text("""
            SELECT MAX(value) - MIN(value) AS kwh_delta
            FROM trx_reading
            WHERE device_id = :device_id
              AND parameter_code = :param_code
              AND ts >= date_trunc('month', NOW())
        """), {"device_id": b.device_id, "param_code": param})).fetchone()

        delta = float(row_d[0]) if row_d is not None and row_d[0] is not None else None
        if delta is not None:
            total_kwh += b.sign * delta
            active += 1

        binding_details.append({
            "assgn_id": b.assgn_id,
            "device_id": b.device_id,
            "circuit_code": b.circuit_code,
            "parameter_code": param,
            "sign": b.sign,
            "kwh_delta": delta,
        })

    result = {
        "ecsu_id": ecsu_id,
        "ecsu_code": ecsu.ecsu_code,
        "ecsu_name": ecsu.ecsu_name,
        "monthly_kwh": total_kwh,
        "active_bindings": active,
        "total_bindings": len(bindings),
        "window": "month_to_date",
        "bindings": binding_details,
        "cached": False,
    }
    _cache_put("monthly", ecsu_id, {**result, "cached": True})
    return result


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


# M-PM-228: schema-driven device_kind → circuit list（hardcode constants）
# URL 自決加 /by-kind/ 區段避免與既有 /{model_id} (int) 同 path 衝突
# frontend M-PM-229 需對齊此 URL

from app.constants.device_circuits import DEVICE_MODEL_CIRCUITS, get_circuits


@router.get("/device-models/circuits")
async def get_all_device_circuits():
    """取全部 device_kind → circuit list（級聯下拉 fallback）.

    M-PM-228 schema-driven hardcode；frontend ECSU 綁定 dialog 用於初始 dropdown。
    """
    return {
        "device_kinds": list(DEVICE_MODEL_CIRCUITS.keys()),
        "circuits_by_kind": DEVICE_MODEL_CIRCUITS,
    }


@router.get("/device-models/by-kind/{device_kind}/circuits")
async def get_circuits_by_device_kind(device_kind: str):
    """取指定 device_kind 的 circuit list.

    M-PM-228 業主明示「乙. Long-term schema-driven」；hardcode 在 backend constants
    （01_Edge 設備地圖採證源）；不擴 schema。

    支援 device_kind: aem_drb / cpm23 / cpm12d（PM 信 §2.3 三件採證源）

    Note: URL 加 /by-kind/ 區段避免與既有 GET /device-models/{model_id}/circuits (int) 衝突；
    frontend M-PM-229 需依此 URL 對齊。
    """
    circuits = get_circuits(device_kind)
    if circuits is None:
        raise HTTPException(
            status_code=404,
            detail=f"device_kind {device_kind!r} not supported; "
                   f"available: {sorted(DEVICE_MODEL_CIRCUITS.keys())}",
        )
    return {
        "device_kind": device_kind,
        "circuits": circuits,
        "count": len(circuits),
    }


# ========== /admin/circuits ==========
# M-PM-249 §二 工作包 B endpoint #1：device × circuit 二維 flatten
# 業務需求：Pananora 房間-迴路綁定下拉用（避免 frontend N+1 call: list devices → per device list circuits）


def _resolve_device_kind_from_id(device_id: str) -> str | None:
    """從 device_id prefix 推真實 device_kind（aem_drb / cpm23 / cpm12d / tcs300b03_di / tcs300b04_do）.

    ems_device.device_kind 在 V2-final 退化成粗類別 'modbus_meter'；真實 sub-type 編碼在
    device_id prefix（採證：'aem_drb-TYDARES-E04-slave20', 'cpm12d-...', 'cpm23-...'）；對齊
    device_circuits._parse_device_kind() 既有 pattern.
    """
    for kind in DEVICE_MODEL_CIRCUITS.keys():
        if device_id.startswith(kind + "-") or device_id.startswith(kind + "_"):
            return kind
    return None


@router.get("/circuits")
async def list_all_circuits(
    device_kind: str | None = Query(None, description="filter aem_drb / cpm23 / cpm12d / tcs300b03_di / tcs300b04_do"),
    edge_id: str | None = Query(None, description="filter by edge_id"),
    db: AsyncSession = Depends(get_db),
):
    """列全部迴路（device × circuit 二維 flatten）.

    M-PM-249 §二 工作包 B #1（Pananora 整合方案丙）：每筆 row =（device, circuit）對；
    避免前端 N+1 呼叫先列 device 再 per device 列 circuit。

    底層：JOIN ems_device × DEVICE_MODEL_CIRCUITS (Python const) flatten；不查 cagg/trx.

    NB: 真實 device sub-type 從 device_id prefix 推（ems_device.device_kind 退化成
    'modbus_meter'；採證 M-PM-249 §二 implementation）.
    """
    stmt = select(EmsDevice).where(EmsDevice.deleted_at.is_(None))
    if edge_id:
        stmt = stmt.where(EmsDevice.edge_id == edge_id)
    stmt = stmt.order_by(EmsDevice.edge_id, EmsDevice.device_id)
    devices = (await db.execute(stmt)).scalars().all()

    result = []
    for d in devices:
        resolved_kind = _resolve_device_kind_from_id(d.device_id)
        if resolved_kind is None:
            continue  # 無對應 sub-type schema（例如 IR/thermal）
        if device_kind and resolved_kind != device_kind:
            continue  # filter
        circuits = get_circuits(resolved_kind)
        if not circuits:
            continue
        for c in circuits:
            result.append({
                "device_id": d.device_id,
                "device_kind": resolved_kind,  # 真實 sub-type（非 'modbus_meter'）
                "device_kind_db": d.device_kind,  # debug 用：原 DB column 值
                "edge_id": d.edge_id,
                "display_name": d.display_name,
                "circuit_code": c["code"],
                "circuit_name": c["name"],
                "circuit_category": c["category"],
            })
    return {"circuits": result, "total": len(result)}


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
    """List all 811C IR devices with metadata (含 ip_address；M-P11-E36 兌現).

    Source: trx_reading DISTINCT device_id LIKE '811c_%' (V2-final per-device cutover)
    + LEFT JOIN ems_ir_device_metadata for display_name + ip_address.

    Returns: [{device_id, display_name (nullable), ip_address (nullable), last_seen}]

    ip_address 從 ems-ipscan container (arp-scan LAN broadcast) event-driven 寫入;
    業主 0 操作;同 LAN 192.168.10.0/24 ICP DAS iSN-811C OUI 00:0d:e0:92:* filter.
    """
    # M-P12-077 soft archive: 拆除設備 filter 掉
    #   archived_at IS NULL → 未封存;正常顯示
    #   last_seen > archived_at → 封存後又上報 (重裝同 MAC) → 自動復活顯示
    #   archived_at >= last_seen → 封存後無新上報 → 隱藏 (拆除設備)
    result = await db.execute(text("""
        SELECT
          t.device_id,
          m.display_name,
          m.ip_address,
          MAX(t.ts) AS last_seen,
          m.archived_at,
          m.edge_id
        FROM trx_reading t
        LEFT JOIN ems_ir_device_metadata m ON m.device_id = t.device_id
        WHERE t.device_id LIKE '811c_%'
        GROUP BY t.device_id, m.display_name, m.ip_address, m.archived_at, m.edge_id
        HAVING m.archived_at IS NULL OR MAX(t.ts) > m.archived_at
        ORDER BY t.device_id
    """))
    return [
        {
            "device_id": row[0],
            "display_name": row[1],
            "ip_address": row[2],
            "last_seen": row[3].isoformat() if row[3] else None,
            # M-P12-109：edge_id 補值後透傳（M-PM-111 Phase 2 遺欠；E66 fallback 斷根配套）
            "edge_id": row[5],
        }
        for row in result.fetchall()
    ]


# M-P11-E36 §2: ip-scan-report endpoint
# ems-ipscan container (network_mode=host + arp-scan) bulk 上報 MAC→IP map
# event-driven (新 MAC 進 trx_reading 觸發 / startup 一次補齊);業主 0 操作


@router.post("/ir-devices/ip-scan-report")
async def ip_scan_report(body: dict[str, Any] = Body(...), db: AsyncSession = Depends(get_db)):
    """Bulk update ems_ir_device_metadata.ip_address from ARP scan results.

    Body shape:
        {
          "scanned_at": "2026-05-27T13:30:00+08:00",
          "devices": [
            {"mac": "00:0d:e0:92:11:55", "ip": "192.168.10.83"},
            {"mac": "00:0d:e0:92:14:40", "ip": "192.168.10.93"},
            ...
          ]
        }

    對齊 device_id naming: `811c_<mac:換-、lower>` (e.g. 811c_00-0d-e0-92-11-55)
    UPSERT logic: 已存在 device_id → UPDATE ip_address;新 MAC → INSERT 含 ip_address.

    回傳: { "updated": N, "inserted": N, "skipped": N }
    """
    scanned_devices = body.get("devices", [])
    if not isinstance(scanned_devices, list):
        raise HTTPException(status_code=400, detail="body.devices must be a list")

    updated = 0
    inserted = 0
    skipped = 0

    for entry in scanned_devices:
        mac = entry.get("mac")
        ip = entry.get("ip")
        if not mac or not ip:
            skipped += 1
            continue

        # MAC normalize: lowercase + colon→dash; device_id pattern: 811c_<mac>
        mac_normalized = mac.lower().replace(":", "-")
        device_id = f"811c_{mac_normalized}"

        # UPSERT: 既存 device_id → UPDATE; 新 → INSERT (display_name=NULL 待業主編輯)
        result = await db.execute(text("""
            INSERT INTO ems_ir_device_metadata (device_id, ip_address, updated_at)
            VALUES (:device_id, :ip, NOW())
            ON CONFLICT (device_id) DO UPDATE
            SET ip_address = EXCLUDED.ip_address,
                updated_at = NOW()
            RETURNING xmax = 0 AS inserted_flag
        """), {"device_id": device_id, "ip": ip})
        row = result.fetchone()
        if row and row[0]:
            inserted += 1
        else:
            updated += 1

    await db.commit()

    return {
        "scanned_at": body.get("scanned_at"),
        "total_received": len(scanned_devices),
        "updated": updated,
        "inserted": inserted,
        "skipped": skipped,
    }


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


# M-P12-077: IR device soft archive（老王 5/28 明示「移除已取消安裝的 811C」）
# 不刪 trx_reading 歷史（熱像資料保留）;只設 ems_ir_device_metadata.archived_at;
# GET /ir-devices filter archived_at >= last_seen 的隱藏;重裝同 MAC 又上報自動復活


@router.delete("/ir-devices/{device_id}")
async def archive_ir_device(device_id: str, db: AsyncSession = Depends(get_db)):
    """Soft archive IR device (拆除設備從列表隱藏;歷史 trx_reading 保留).

    UPSERT ems_ir_device_metadata.archived_at = NOW().
    device 可能無 metadata row（未命名）→ INSERT；既存 → UPDATE.

    Returns: { device_id, archived_at, status }
    """
    if not device_id.startswith("811c_"):
        raise HTTPException(
            status_code=422,
            detail=f"device_id must start with '811c_'; got: {device_id}"
        )

    result = await db.execute(text("""
        INSERT INTO ems_ir_device_metadata (device_id, archived_at, updated_at)
        VALUES (:device_id, NOW(), NOW())
        ON CONFLICT (device_id) DO UPDATE
        SET archived_at = NOW(),
            updated_at = NOW()
        RETURNING archived_at
    """), {"device_id": device_id})
    row = result.fetchone()
    await db.commit()

    db.add(EmsEvent(
        event_kind="operation",
        severity="info",
        device_id=device_id,
        actor="admin",
        message=f"IR device archived (拆除設備列表隱藏): {device_id}",
    ))
    await db.commit()

    return {
        "device_id": device_id,
        "archived_at": row[0].isoformat() if row and row[0] else None,
        "status": "archived",
    }
