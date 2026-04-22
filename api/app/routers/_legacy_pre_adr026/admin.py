"""Admin CRUD API — serves the admin-ui backend.

Generic CRUD for all FND_* tables + Edge management.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_db, verify_bearer_token
from app.services import command_service
from app.services.wakeup_service import send_wakeup

router = APIRouter(prefix="/admin")


# ---------------------------------------------------------------------------
# Generic CRUD helper
# ---------------------------------------------------------------------------

async def _list_table(db: AsyncSession, table: str) -> List[Dict[str, Any]]:
    result = await db.execute(text(f"SELECT * FROM {table} ORDER BY 1"))
    columns = result.keys()
    return [dict(zip(columns, row)) for row in result.fetchall()]


async def _get_one(db: AsyncSession, table: str, pk_col: str, pk_val: Any) -> Dict[str, Any]:
    result = await db.execute(
        text(f"SELECT * FROM {table} WHERE {pk_col} = :val"), {"val": pk_val}
    )
    row = result.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Not found")
    return dict(zip(result.keys(), row))


async def _insert(db: AsyncSession, table: str, data: Dict[str, Any]) -> Dict[str, Any]:
    cols = [k for k in data.keys() if data[k] is not None]
    placeholders = [f":{k}" for k in cols]
    col_str = ", ".join(cols)
    val_str = ", ".join(placeholders)
    result = await db.execute(
        text(f"INSERT INTO {table} ({col_str}) VALUES ({val_str}) RETURNING *"),
        {k: data[k] for k in cols},
    )
    await db.commit()
    row = result.fetchone()
    return dict(zip(result.keys(), row))


async def _update(db: AsyncSession, table: str, pk_col: str, pk_val: Any, data: Dict[str, Any]) -> Dict[str, Any]:
    sets = [f"{k} = :{k}" for k in data.keys() if k != pk_col and data[k] is not None]
    if not sets:
        raise HTTPException(status_code=400, detail="No fields to update")
    set_str = ", ".join(sets)
    params = {k: v for k, v in data.items() if k != pk_col and v is not None}
    params["pk"] = pk_val
    result = await db.execute(
        text(f"UPDATE {table} SET {set_str}, updated_at = NOW() WHERE {pk_col} = :pk RETURNING *"),
        params,
    )
    await db.commit()
    row = result.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Not found")
    return dict(zip(result.keys(), row))


async def _delete(db: AsyncSession, table: str, pk_col: str, pk_val: Any) -> None:
    result = await db.execute(
        text(f"DELETE FROM {table} WHERE {pk_col} = :val"), {"val": pk_val}
    )
    await db.commit()
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Not found")


# ---------------------------------------------------------------------------
# Edge Gateway (fnd_hub)
# ---------------------------------------------------------------------------

@router.get("/hubs")
async def list_hubs(db: AsyncSession = Depends(get_db), _=Depends(verify_bearer_token)):
    return await _list_table(db, "fnd_hub")

@router.post("/hubs")
async def create_hub(body: Dict[str, Any], db: AsyncSession = Depends(get_db), _=Depends(verify_bearer_token)):
    return await _insert(db, "fnd_hub", body)

@router.put("/hubs/{hub_id}")
async def update_hub(hub_id: int, body: Dict[str, Any], db: AsyncSession = Depends(get_db), _=Depends(verify_bearer_token)):
    return await _update(db, "fnd_hub", "hub_id", hub_id, body)

@router.delete("/hubs/{hub_id}")
async def delete_hub(hub_id: int, db: AsyncSession = Depends(get_db), _=Depends(verify_bearer_token)):
    await _delete(db, "fnd_hub", "hub_id", hub_id)
    return {"status": "deleted"}


# ---------------------------------------------------------------------------
# Meters (fnd_meter)
# ---------------------------------------------------------------------------

@router.get("/meters")
async def list_meters(db: AsyncSession = Depends(get_db), _=Depends(verify_bearer_token)):
    return await _list_table(db, "fnd_meter")

@router.post("/meters")
async def create_meter(body: Dict[str, Any], db: AsyncSession = Depends(get_db), _=Depends(verify_bearer_token)):
    return await _insert(db, "fnd_meter", body)

@router.put("/meters/{meter_id}")
async def update_meter(meter_id: int, body: Dict[str, Any], db: AsyncSession = Depends(get_db), _=Depends(verify_bearer_token)):
    return await _update(db, "fnd_meter", "meter_id", meter_id, body)

@router.delete("/meters/{meter_id}")
async def delete_meter(meter_id: int, db: AsyncSession = Depends(get_db), _=Depends(verify_bearer_token)):
    await _delete(db, "fnd_meter", "meter_id", meter_id)
    return {"status": "deleted"}


# ---------------------------------------------------------------------------
# Modbus Devices (fnd_modbus_device)
# ---------------------------------------------------------------------------

@router.get("/modbus-devices")
async def list_modbus_devices(db: AsyncSession = Depends(get_db), _=Depends(verify_bearer_token)):
    return await _list_table(db, "fnd_modbus_device")

@router.post("/modbus-devices")
async def create_modbus_device(body: Dict[str, Any], db: AsyncSession = Depends(get_db), _=Depends(verify_bearer_token)):
    return await _insert(db, "fnd_modbus_device", body)

@router.put("/modbus-devices/{device_id}")
async def update_modbus_device(device_id: int, body: Dict[str, Any], db: AsyncSession = Depends(get_db), _=Depends(verify_bearer_token)):
    return await _update(db, "fnd_modbus_device", "modbus_device_id", device_id, body)

@router.delete("/modbus-devices/{device_id}")
async def delete_modbus_device(device_id: int, db: AsyncSession = Depends(get_db), _=Depends(verify_bearer_token)):
    await _delete(db, "fnd_modbus_device", "modbus_device_id", device_id)
    return {"status": "deleted"}


# ---------------------------------------------------------------------------
# Modbus Models (fnd_modbus_device_model)
# ---------------------------------------------------------------------------

@router.get("/modbus-models")
async def list_modbus_models(db: AsyncSession = Depends(get_db), _=Depends(verify_bearer_token)):
    return await _list_table(db, "fnd_modbus_device_model")

@router.post("/modbus-models")
async def create_modbus_model(body: Dict[str, Any], db: AsyncSession = Depends(get_db), _=Depends(verify_bearer_token)):
    return await _insert(db, "fnd_modbus_device_model", body)

@router.put("/modbus-models/{model_id}")
async def update_modbus_model(model_id: int, body: Dict[str, Any], db: AsyncSession = Depends(get_db), _=Depends(verify_bearer_token)):
    return await _update(db, "fnd_modbus_device_model", "modbus_device_model_id", model_id, body)

@router.delete("/modbus-models/{model_id}")
async def delete_modbus_model(model_id: int, db: AsyncSession = Depends(get_db), _=Depends(verify_bearer_token)):
    await _delete(db, "fnd_modbus_device_model", "modbus_device_model_id", model_id)
    return {"status": "deleted"}


# ---------------------------------------------------------------------------
# Circuits (fnd_modbus_device_circuit)
# ---------------------------------------------------------------------------

@router.get("/circuits")
async def list_circuits(db: AsyncSession = Depends(get_db), _=Depends(verify_bearer_token)):
    return await _list_table(db, "fnd_modbus_device_circuit")

@router.post("/circuits")
async def create_circuit(body: Dict[str, Any], db: AsyncSession = Depends(get_db), _=Depends(verify_bearer_token)):
    return await _insert(db, "fnd_modbus_device_circuit", body)

@router.put("/circuits/{circuit_id}")
async def update_circuit(circuit_id: int, body: Dict[str, Any], db: AsyncSession = Depends(get_db), _=Depends(verify_bearer_token)):
    return await _update(db, "fnd_modbus_device_circuit", "modbus_device_circuit_id", circuit_id, body)

@router.delete("/circuits/{circuit_id}")
async def delete_circuit(circuit_id: int, db: AsyncSession = Depends(get_db), _=Depends(verify_bearer_token)):
    await _delete(db, "fnd_modbus_device_circuit", "modbus_device_circuit_id", circuit_id)
    return {"status": "deleted"}


# ---------------------------------------------------------------------------
# ECSU (fnd_ecsu)
# ---------------------------------------------------------------------------

@router.get("/ecsu")
async def list_ecsu(db: AsyncSession = Depends(get_db), _=Depends(verify_bearer_token)):
    return await _list_table(db, "fnd_ecsu")

@router.post("/ecsu")
async def create_ecsu(body: Dict[str, Any], db: AsyncSession = Depends(get_db), _=Depends(verify_bearer_token)):
    return await _insert(db, "fnd_ecsu", body)

@router.put("/ecsu/{ecsu_id}")
async def update_ecsu(ecsu_id: int, body: Dict[str, Any], db: AsyncSession = Depends(get_db), _=Depends(verify_bearer_token)):
    return await _update(db, "fnd_ecsu", "ecsu_id", ecsu_id, body)

@router.delete("/ecsu/{ecsu_id}")
async def delete_ecsu(ecsu_id: int, db: AsyncSession = Depends(get_db), _=Depends(verify_bearer_token)):
    await _delete(db, "fnd_ecsu", "ecsu_id", ecsu_id)
    return {"status": "deleted"}


# ---------------------------------------------------------------------------
# Electric Parameters (fnd_electric_parameter)
# ---------------------------------------------------------------------------

@router.get("/electric-params")
async def list_electric_params(db: AsyncSession = Depends(get_db), _=Depends(verify_bearer_token)):
    return await _list_table(db, "fnd_electric_parameter")

@router.post("/electric-params")
async def create_electric_param(body: Dict[str, Any], db: AsyncSession = Depends(get_db), _=Depends(verify_bearer_token)):
    return await _insert(db, "fnd_electric_parameter", body)

@router.put("/electric-params/{param_id}")
async def update_electric_param(param_id: int, body: Dict[str, Any], db: AsyncSession = Depends(get_db), _=Depends(verify_bearer_token)):
    return await _update(db, "fnd_electric_parameter", "electric_parameter_id", param_id, body)

@router.delete("/electric-params/{param_id}")
async def delete_electric_param(param_id: int, db: AsyncSession = Depends(get_db), _=Depends(verify_bearer_token)):
    await _delete(db, "fnd_electric_parameter", "electric_parameter_id", param_id)
    return {"status": "deleted"}


# ---------------------------------------------------------------------------
# Billing Standard (fnd_elec_billing_standard)
# ---------------------------------------------------------------------------

@router.get("/billing-standard")
async def list_billing_standard(db: AsyncSession = Depends(get_db), _=Depends(verify_bearer_token)):
    return await _list_table(db, "fnd_elec_billing_standard")

@router.post("/billing-standard")
async def create_billing_standard(body: Dict[str, Any], db: AsyncSession = Depends(get_db), _=Depends(verify_bearer_token)):
    return await _insert(db, "fnd_elec_billing_standard", body)

@router.put("/billing-standard/{standard_id}")
async def update_billing_standard(standard_id: int, body: Dict[str, Any], db: AsyncSession = Depends(get_db), _=Depends(verify_bearer_token)):
    return await _update(db, "fnd_elec_billing_standard", "elec_billing_standard_id", standard_id, body)

@router.delete("/billing-standard/{standard_id}")
async def delete_billing_standard(standard_id: int, db: AsyncSession = Depends(get_db), _=Depends(verify_bearer_token)):
    await _delete(db, "fnd_elec_billing_standard", "elec_billing_standard_id", standard_id)
    return {"status": "deleted"}


# ---------------------------------------------------------------------------
# System Config (fnd_config)
# ---------------------------------------------------------------------------

@router.get("/configs")
async def list_configs(db: AsyncSession = Depends(get_db), _=Depends(verify_bearer_token)):
    return await _list_table(db, "fnd_config")

@router.post("/configs")
async def create_config(body: Dict[str, Any], db: AsyncSession = Depends(get_db), _=Depends(verify_bearer_token)):
    return await _insert(db, "fnd_config", body)

@router.put("/configs/{config_id}")
async def update_config(config_id: int, body: Dict[str, Any], db: AsyncSession = Depends(get_db), _=Depends(verify_bearer_token)):
    return await _update(db, "fnd_config", "config_id", config_id, body)

@router.delete("/configs/{config_id}")
async def delete_config(config_id: int, db: AsyncSession = Depends(get_db), _=Depends(verify_bearer_token)):
    await _delete(db, "fnd_config", "config_id", config_id)
    return {"status": "deleted"}


# ---------------------------------------------------------------------------
# API Calls (fnd_api_call)
# ---------------------------------------------------------------------------

@router.get("/api-calls")
async def list_api_calls(db: AsyncSession = Depends(get_db), _=Depends(verify_bearer_token)):
    return await _list_table(db, "fnd_api_call")

@router.post("/api-calls")
async def create_api_call(body: Dict[str, Any], db: AsyncSession = Depends(get_db), _=Depends(verify_bearer_token)):
    return await _insert(db, "fnd_api_call", body)

@router.delete("/api-calls/{call_id}")
async def delete_api_call(call_id: int, db: AsyncSession = Depends(get_db), _=Depends(verify_bearer_token)):
    await _delete(db, "fnd_api_call", "api_call_id", call_id)
    return {"status": "deleted"}


# ---------------------------------------------------------------------------
# Meter Swap (fnd_meter_swap) — 電表替換管理
# ---------------------------------------------------------------------------

@router.get("/meter-swaps")
async def list_meter_swaps(db: AsyncSession = Depends(get_db), _=Depends(verify_bearer_token)):
    return await _list_table(db, "fnd_meter_swap")

@router.post("/meter-swaps")
async def create_meter_swap(body: Dict[str, Any], db: AsyncSession = Depends(get_db), _=Depends(verify_bearer_token)):
    return await _insert(db, "fnd_meter_swap", body)


# ---------------------------------------------------------------------------
# Edge Status (ems_edge)
# ---------------------------------------------------------------------------

@router.get("/ems-devices")
async def list_ems_devices(db: AsyncSession = Depends(get_db), _=Depends(verify_bearer_token)):
    """List all ems_device entries with last ingest time."""
    result = await db.execute(
        text("""
            SELECT d.*,
                   i.last_received
            FROM ems_device d
            LEFT JOIN (
                SELECT device_id, MAX(received_at) as last_received
                FROM ems_ingest_inbox
                GROUP BY device_id
            ) i ON d.device_id = i.device_id
            ORDER BY d.edge_id, d.device_id
        """)
    )
    columns = result.keys()
    return [dict(zip(columns, row)) for row in result.fetchall()]


@router.get("/edges")
async def list_edges(db: AsyncSession = Depends(get_db), _=Depends(verify_bearer_token)):
    return await _list_table(db, "ems_edge")


@router.get("/edges/{edge_id}/devices")
async def list_edge_devices(edge_id: str, db: AsyncSession = Depends(get_db), _=Depends(verify_bearer_token)):
    """List all ems_device entries belonging to an Edge."""
    result = await db.execute(
        text("SELECT * FROM ems_device WHERE edge_id = :edge_id ORDER BY device_id"),
        {"edge_id": edge_id},
    )
    columns = result.keys()
    return [dict(zip(columns, row)) for row in result.fetchall()]


# ---------------------------------------------------------------------------
# Edge Credentials / Approval (ems_edge_credential) — ADR-021
# ---------------------------------------------------------------------------

@router.get("/edge-credentials")
async def list_edge_credentials(db: AsyncSession = Depends(get_db), _=Depends(verify_bearer_token)):
    return await _list_table(db, "ems_edge_credential")

@router.post("/edge-credentials/{edge_id}/approve")
async def approve_edge(edge_id: str, db: AsyncSession = Depends(get_db), _=Depends(verify_bearer_token)):
    # 允許的來源狀態：
    # - pending / pending_replace：正常審核流程
    # - maintenance：誤操作或硬體未換但已按了「維護中」時，需一鍵取消
    await db.execute(
        text("""
            UPDATE ems_edge_credential
            SET status = 'approved',
                approved_at = NOW(),
                approved_by = 'admin',
                maintenance_at = NULL,
                maintenance_by = NULL
            WHERE edge_id = :edge_id
              AND status IN ('pending', 'pending_replace', 'maintenance')
        """),
        {"edge_id": edge_id},
    )
    await db.commit()
    return {"status": "approved"}

@router.post("/edge-credentials/{edge_id}/maintenance")
async def maintenance_edge(edge_id: str, db: AsyncSession = Depends(get_db), _=Depends(verify_bearer_token)):
    await db.execute(
        text("""
            UPDATE ems_edge_credential
            SET status = 'maintenance', maintenance_at = NOW(), maintenance_by = 'admin'
            WHERE edge_id = :edge_id AND status = 'approved'
        """),
        {"edge_id": edge_id},
    )
    await db.commit()
    return {"status": "maintenance"}

@router.post("/edge-credentials/{edge_id}/revoke")
async def revoke_edge(edge_id: str, db: AsyncSession = Depends(get_db), _=Depends(verify_bearer_token)):
    await db.execute(
        text("""
            UPDATE ems_edge_credential
            SET status = 'revoked', revoked_at = NOW()
            WHERE edge_id = :edge_id AND status != 'revoked'
        """),
        {"edge_id": edge_id},
    )
    await db.commit()
    return {"status": "revoked"}


class RenameEdgeBody(BaseModel):
    hostname: str


@router.patch("/edge-credentials/{edge_id}/hostname")
async def rename_edge_hostname(
    edge_id: str,
    body: RenameEdgeBody,
    db: AsyncSession = Depends(get_db),
    _=Depends(verify_bearer_token),
):
    """修改 Edge 的主機名稱（ems_edge_credential.hostname）。"""
    new_name = body.hostname.strip()
    if not new_name:
        raise HTTPException(status_code=400, detail="hostname 不可為空")
    result = await db.execute(
        text("UPDATE ems_edge_credential SET hostname = :h WHERE edge_id = :edge_id"),
        {"h": new_name, "edge_id": edge_id},
    )
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Edge not found")
    await db.commit()
    return {"status": "ok", "hostname": new_name}


class RenameDeviceBody(BaseModel):
    device_name: str


@router.patch("/devices/{device_id}/name")
async def rename_device(
    device_id: str,
    body: RenameDeviceBody,
    db: AsyncSession = Depends(get_db),
    _=Depends(verify_bearer_token),
):
    """修改設備顯示名稱（ems_device.device_name）。不改 device_id（仍為 PK 且與 Edge device_code 對齊）。"""
    new_name = body.device_name.strip()
    if not new_name:
        raise HTTPException(status_code=400, detail="device_name 不可為空")
    result = await db.execute(
        text("UPDATE ems_device SET device_name = :n WHERE device_id = :device_id"),
        {"n": new_name, "device_id": device_id},
    )
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Device not found")
    await db.commit()
    return {"status": "ok", "device_name": new_name}


# ---------------------------------------------------------------------------
# Scan Bootstrap — 首次掃描前自動建立佔位設備
# ---------------------------------------------------------------------------

@router.post("/edges/{edge_id}/devices/bootstrap")
async def bootstrap_edge_device(
    edge_id: str,
    db: AsyncSession = Depends(get_db),
    _=Depends(verify_bearer_token),
):
    """Create a placeholder device so scan commands can be dispatched to this Edge.
    Used only for first-time scan when no ems_device exists yet.
    The placeholder is cleaned up after real devices are confirmed.
    """
    device_id = f"_scan-{edge_id}"
    await db.execute(
        text("""
            INSERT INTO ems_device (device_id, edge_id, device_type, device_name)
            VALUES (:device_id, :edge_id, '_placeholder', '掃描佔位')
            ON CONFLICT (device_id) DO NOTHING
        """),
        {"device_id": device_id, "edge_id": edge_id},
    )
    await db.commit()
    return {"device_id": device_id}


# ---------------------------------------------------------------------------
# Scan Confirm — 批次建立設備 + 下發 device.configure
# ---------------------------------------------------------------------------

class ConfirmCircuit(BaseModel):
    circuit: str
    ct_pri: int = 0
    wire: str = ""

class ConfirmDevice(BaseModel):
    device_id: str
    device_type: str
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
    _=Depends(verify_bearer_token),
):
    """Batch-create ems_device records + issue device.configure to Edge."""
    if not body.devices:
        raise HTTPException(status_code=400, detail="No devices to confirm")

    # 1. Batch insert ems_device (ON CONFLICT DO NOTHING for idempotency)
    created_count = 0
    for dev in body.devices:
        result = await db.execute(
            text("""
                INSERT INTO ems_device (device_id, edge_id, device_type, device_name)
                VALUES (:device_id, :edge_id, :device_type, :device_name)
                ON CONFLICT (device_id) DO NOTHING
            """),
            {
                "device_id": dev.device_id,
                "edge_id": edge_id,
                "device_type": dev.device_type,
                "device_name": dev.device_name or f"{dev.device_type}-{edge_id}-slave{dev.slave_id}",
            },
        )
        created_count += result.rowcount
    await db.commit()

    # 2. Clean up bootstrap placeholder if exists.
    #    placeholder 期間建的 scan commands 會 FK 指向它，直接 DELETE 會踩
    #    fk_ems_commands_device。把這些歷史轉給第一個 real device（語意上
    #    本來就是「為了建立這批設備而做的掃描」），然後再刪 placeholder。
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

    # 3. Build device.configure payload — **完整 snapshot**
    #
    # Edge 端 handler 用全量覆寫策略寫 active_devices.json，所以每次下發的
    # payload 必須包含這個 Edge 底下**所有**設備，否則會把舊設備沖掉。
    #
    # 既有設備的 slave_id/bus_id/active_circuits 目前只存在於歷史
    # `device.configure` 指令的 payload 裡（ems_device 表不含這些欄位），
    # 所以我們從歷史 commands 拉出來，再用本次 body.devices 覆蓋。
    #
    # 長期：應該把完整 device schema 存進 Central DB 當 SSOT。
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

    # 本次 body.devices 覆蓋既有（circuits/bus_id 都以本次為準）
    for dev in body.devices:
        active_circuits = {}
        for c in dev.circuits:
            active_circuits[c.circuit] = {
                "ct_pri": c.ct_pri,
                "wire": c.wire,
                "label": "",
            }
        existing_map[dev.device_id] = {
            "device_code": dev.device_id,  # ← Central SSOT
            "device_type": dev.device_type,
            "slave_id": dev.slave_id,
            "bus_id": dev.bus_id,
            "active_circuits": active_circuits,
        }

    # 過濾掉已從 ems_device 刪除的 / placeholder 設備
    valid_rows = await db.execute(
        text("SELECT device_id FROM ems_device WHERE edge_id = :edge_id"),
        {"edge_id": edge_id},
    )
    valid_ids = {r[0] for r in valid_rows.fetchall() if not r[0].startswith("_")}
    configure_devices = [d for code, d in existing_map.items() if code in valid_ids]

    # 4. Issue device.configure command (use first device_id as target)
    configure_command_id = await command_service.create_command(
        db=db,
        device_id=body.devices[0].device_id,
        command_type="device.configure",
        payload={"devices": configure_devices},
        issued_by="admin-ui",
    )

    # 5. 發 MQTT wake-up signal 讓 Edge 立即領取 configure 指令（non-fatal）
    try:
        send_wakeup(edge_id=edge_id)
    except Exception:
        pass

    return {
        "created_count": created_count,
        "command_id": configure_command_id,
    }
