"""V2-final Config Pull Service (ADR-026 DR-026-04).

UI 改 ems_device → 遞增 ems_edge.config_version
Edge GET /v1/edges/{edge_id}/desired-config → 回傳所有 active device
Edge apply → POST /v1/edges/{edge_id}/config/ack → 更新 edge.config_version
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models import (
    EmsDevice,
    EmsDeviceModbus,
    EmsDeviceThermal,
    EmsEdge,
    EmsEvent,
    FndDeviceModel,
    FndDeviceModelCircuit,
    FndDeviceModelParam,
)


async def build_desired_config(db: AsyncSession, edge_id: str) -> dict:
    """組出 Edge 的 desired-config payload。

    讀 ems_device + 子表 + model library → 打成 JSON，算 hash 作為版本指紋。
    """
    # 所有未軟刪除、enabled 的 device
    result = await db.execute(
        select(EmsDevice).where(
            EmsDevice.edge_id == edge_id,
            EmsDevice.deleted_at.is_(None),
        )
    )
    devices = result.scalars().all()

    items: list[dict] = []
    for d in devices:
        item: dict = {
            "device_id": d.device_id,
            "device_kind": d.device_kind,
            "display_name": d.display_name,
            "enabled": d.enabled,
            "deleted": False,
        }

        if d.device_kind == "modbus_meter":
            mb_result = await db.execute(
                select(EmsDeviceModbus).where(EmsDeviceModbus.device_id == d.device_id)
            )
            mb = mb_result.scalar_one_or_none()
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

        elif d.device_kind == "thermal":
            th_result = await db.execute(
                select(EmsDeviceThermal).where(EmsDeviceThermal.device_id == d.device_id)
            )
            th = th_result.scalar_one_or_none()
            if th:
                item["thermal"] = {
                    "camera_model": th.camera_model,
                    "mac_addr": th.mac_addr,
                    "zone_count": th.zone_count,
                    "upload_interval_sec": th.upload_interval_sec,
                }

        # Model + circuits + params（供 Edge 解析用）
        if d.model_id:
            model_result = await db.execute(
                select(FndDeviceModel).where(FndDeviceModel.model_id == d.model_id)
            )
            model = model_result.scalar_one_or_none()
            if model:
                circuits_result = await db.execute(
                    select(FndDeviceModelCircuit).where(
                        FndDeviceModelCircuit.model_id == d.model_id
                    ).order_by(FndDeviceModelCircuit.display_seq)
                )
                circuits = circuits_result.scalars().all()

                model_dict = {
                    "model_code": model.model_code,
                    "model_name": model.model_name,
                    "model_kind": model.model_kind,
                    "circuits": [],
                }
                for c in circuits:
                    params_result = await db.execute(
                        select(FndDeviceModelParam).where(
                            FndDeviceModelParam.circuit_id == c.circuit_id
                        )
                    )
                    params = params_result.scalars().all()
                    model_dict["circuits"].append({
                        "circuit_code": c.circuit_code,
                        "circuit_name": c.circuit_name,
                        "params": [
                            {
                                "electric_parameter_id": p.electric_parameter_id,
                                "low_word_address": p.low_word_address,
                                "data_type": p.data_type,
                                "decimal_place": p.decimal_place,
                                "function_code": p.function_code,
                            }
                            for p in params
                        ],
                    })
                item["model"] = model_dict

        items.append(item)

    # 從 ems_edge 拿 config_version
    edge_result = await db.execute(select(EmsEdge).where(EmsEdge.edge_id == edge_id))
    edge = edge_result.scalar_one()

    # Hash 內容作為版本指紋
    items_json = json.dumps(items, sort_keys=True, default=str)
    config_hash = hashlib.sha256(items_json.encode()).hexdigest()

    return {
        "edge_id": edge_id,
        "config_version": edge.config_version,
        "config_hash": config_hash,
        "devices": items,
    }


async def ack_config(
    db: AsyncSession,
    edge_id: str,
    applied_version: int,
    applied_at: str,
    result: str,
    errors: list[str] | None,
) -> None:
    """Edge 回報套用結果。"""
    edge_result = await db.execute(select(EmsEdge).where(EmsEdge.edge_id == edge_id))
    edge = edge_result.scalar_one_or_none()
    if edge is None:
        return

    # 只有 success 才更新 edge.config_version
    if result == "success":
        edge.config_version = applied_version

    severity = "info" if result == "success" else ("warn" if result == "partial" else "error")
    db.add(EmsEvent(
        event_kind="config_sync",
        severity=severity,
        edge_id=edge_id,
        actor=edge_id,
        message=f"config ack: {result} v{applied_version}",
        data_json={
            "applied_version": applied_version,
            "applied_at": applied_at,
            "result": result,
            "errors": errors or [],
        },
    ))
    await db.commit()


async def bump_edge_config_version(db: AsyncSession, edge_id: str) -> int:
    """UI 改動 device 配置時呼叫，遞增 edge.config_version 觸發下次 pull。"""
    from sqlalchemy import text
    result = await db.execute(
        text("""
            UPDATE ems_edge
            SET config_version = config_version + 1,
                updated_at = NOW()
            WHERE edge_id = :edge_id
            RETURNING config_version
        """),
        {"edge_id": edge_id},
    )
    row = result.first()
    await db.commit()
    return row[0] if row else 0


async def get_sync_status(db: AsyncSession, edge_id: str) -> dict | None:
    """UI 查 Edge config 同步狀態（ADR-026 DR-026-04 可觀測性）。

    資料源：
    - db_version：ems_edge.config_version（UI 改動後 bump 的最新期望版本）
    - edge_applied_version：最近一筆 kind=config_sync 的 ack 事件 data_json.applied_version
    - last_ack_at：該事件的 ts
    - last_seen_at：ems_edge.last_seen_at

    回傳 None 表示 edge 不存在。
    """
    edge_result = await db.execute(select(EmsEdge).where(EmsEdge.edge_id == edge_id))
    edge = edge_result.scalar_one_or_none()
    if edge is None:
        return None

    ack_result = await db.execute(
        select(EmsEvent)
        .where(EmsEvent.edge_id == edge_id)
        .where(EmsEvent.event_kind == "config_sync")
        .order_by(EmsEvent.ts.desc())
        .limit(1)
    )
    last_ack = ack_result.scalar_one_or_none()

    applied_version = None
    last_ack_at = None
    if last_ack is not None:
        last_ack_at = last_ack.ts.isoformat() if last_ack.ts else None
        data = last_ack.data_json or {}
        applied_version = data.get("applied_version")

    db_version = edge.config_version or 0
    drift_count = (db_version - applied_version) if applied_version is not None else None
    is_synced = (drift_count == 0) if drift_count is not None else False

    return {
        "edge_id": edge_id,
        "db_version": db_version,
        "edge_applied_version": applied_version,
        "drift_count": drift_count,
        "is_synced": is_synced,
        "last_ack_at": last_ack_at,
        "last_seen_at": edge.last_seen_at.isoformat() if edge.last_seen_at else None,
    }
