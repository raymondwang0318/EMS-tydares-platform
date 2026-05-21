"""V2-final Admin I/O router (M-PM-245).

backend I/O API for remote I/O modules (TCS300B03 DI + TCS300B04 DO).
10 endpoints + 3 Guard logic (partial; depends on ingest pipeline) + manual ack + Telegram stub.

依託 vault SSOT v1.0：`01_Edge/遠端IO_腳位功能模板_TCS300B03_TCS300B04.md` §4.5

⚠️ M-PM-245 §A 採證升報 (M-P12-058)：
1. trx_io_reading ingest pipeline 完全不存在 → 升報 P10C；本卷 status/Guard endpoints 用
   stub fallback + TODO 標記；P10C 補 ingest 後 P12A 第二輪移除 stub。
2. Edge RelayController = MOCK（edge/command/relay_control.py 警告「no physical relay
   connected; stub implementation」）→ 升報 P10C/P13；本卷 control endpoint 派 ems_commands
   command_type='io.do.set' 進 queue 即算「派出」；Edge MOCK 收到 command 寫 log 不動實體。
3. ems_device 0 個 tcs300b row → 業主走 ScanWizard 掃出來才有；本卷 endpoint 不阻塞。

alarm pipeline 複用既建 `ems_alert_active` / `ems_alert_history` / `ems_alert_rule`
（不新建 trx_io_alarm；schema 已含 acked_at/acked_by/ack_note 滿足 §4.5.3.5 需求）。
"""

from __future__ import annotations

import logging
import os
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Path, Query
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.constants.device_circuits import DEVICE_MODEL_CIRCUITS, get_circuits
from app.constants.io_topology import (
    EDGE_TO_SITE,
    IO_DEVICE_KINDS,
    get_site,
    list_fans_template,
    list_sites,
)
from app.dependencies import get_db, verify_admin_token
from app.services import command_service

log = logging.getLogger(__name__)

router = APIRouter(
    prefix="/v1/admin/io",
    tags=["admin-io"],
    dependencies=[Depends(verify_admin_token)],
)


# ============================================================================
# Telegram stub (M-PM-245 §2.5; env-gated; 業主 token 補後 enable)
# ============================================================================

TELEGRAM_ENABLED = os.getenv("TELEGRAM_ENABLED", "false").lower() == "true"
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "")


async def push_telegram_alarm(alarm_summary: dict[str, Any]) -> bool:
    """Telegram push stub; returns True if attempted, False if disabled.

    業主 token + chat_id 補後在 env 啟用：TELEGRAM_ENABLED=true。
    """
    if not TELEGRAM_ENABLED:
        log.info("[Telegram] disabled; skip push (alarm_id=%s)", alarm_summary.get("alarm_id"))
        return False
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        log.warning("[Telegram] missing TELEGRAM_BOT_TOKEN or CHAT_ID; skip")
        return False

    try:
        import httpx  # type: ignore
        message = (
            f"🚨 過載警報\n\n"
            f"場域：{alarm_summary.get('site_code', '?')}\n"
            f"風扇：{alarm_summary.get('fan_label', '?')}\n"
            f"device_id：{alarm_summary.get('device_id', '?')}\n"
            f"channel：{alarm_summary.get('channel', '?')}\n"
            f"觸發：{alarm_summary.get('triggered_at', '?')}\n\n"
            f"📌 狀態：DO 已強制 OFF；等業主 ack\n"
            f"🔧 處理：admin-ui /admin-ui/io 點「確認警報」"
        )
        url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(url, json={"chat_id": TELEGRAM_CHAT_ID, "text": message})
        return True
    except Exception as exc:  # pragma: no cover
        log.exception("[Telegram] push failed: %s", exc)
        return False


# ============================================================================
# §2.1.4 / §2.1.5: 6 場域 + 風扇 template
# ============================================================================


@router.get("/sites")
async def list_io_sites():
    """列 6 IO 場域（Aa/Ab/Ae/Ba/Bc/C → Edge17-22）.

    採證 ems_edge.edge_name 'TYDARES-E17 = 育成-Aa' etc；vault SSOT §2 場域配置。
    """
    sites = list_sites()
    fan_count = len(list_fans_template())  # max 9 (6 negative + 3 circulation)
    return {
        "sites": sites,
        "total": len(sites),
        "fan_template_max": fan_count,
        "note": "每場域實際裝幾個 fan 看現場接線；template 是 max 配置 9 = 6 負壓 + 3 內循環",
    }


@router.get("/sites/{site_code}/fans")
async def list_site_fans(
    site_code: str = Path(..., min_length=1),
    db: AsyncSession = Depends(get_db),
):
    """列場域風扇 + 即時狀態 + 5 狀態組合.

    vault SSOT §4.5 5 狀態：自動 / 手動 / 停止 / 運轉 / 過載

    ⚠️ Stub：trx_io_reading 未 ingest（M-PM-245 §A 升報觸發）→ 風扇 DI/DO 即時狀態回
    {"status": "pending_ingest"}；P10C 補 ingest 後 P12A 第二輪以 SELECT trx_io_reading
    取 latest DI/DO state 補完。
    """
    site = get_site(site_code)
    if site is None:
        raise HTTPException(status_code=404, detail=f"site_code '{site_code}' not found")

    fans = list_fans_template()

    # 查該場域所有 tcs300b03/04 device（fleet 24 device fan-out）
    rows = (await db.execute(text("""
        SELECT device_id, device_kind FROM ems_device
        WHERE edge_id = :edge_id
          AND device_kind = ANY(:io_kinds)
          AND deleted_at IS NULL
        ORDER BY device_id
    """), {
        "edge_id": site["edge_id"],
        "io_kinds": list(IO_DEVICE_KINDS),
    })).fetchall()
    io_devices = [{"device_id": r[0], "device_kind": r[1]} for r in rows]

    return {
        "site_code": site["site_code"],
        "site_name": site["site_name"],
        "edge_id": site["edge_id"],
        "io_devices": io_devices,
        "fans": fans,
        "fan_status_source": "pending_ingest",  # TODO: P10C ingest trx_io_reading 後改 'live'
        "note": "fan state (auto/manual/run/overload) 等 P10C trx_io_reading ingest 後可填",
    }


# ============================================================================
# §2.1.1 / §2.1.2 / §2.1.3: device list / status / channels
# ============================================================================


@router.get("/devices")
async def list_io_devices(
    site_code: str | None = Query(None, description="filter by 6 場域 Aa/Ab/Ae/Ba/Bc/C"),
    device_kind: str | None = Query(None, description="filter tcs300b03_di | tcs300b04_do"),
    db: AsyncSession = Depends(get_db),
):
    """列遠端 I/O 設備（device_kind in {tcs300b03_di, tcs300b04_do}）."""
    where = ["d.device_kind = ANY(:io_kinds)", "d.deleted_at IS NULL"]
    params: dict[str, Any] = {"io_kinds": list(IO_DEVICE_KINDS)}

    if device_kind:
        if device_kind not in IO_DEVICE_KINDS:
            raise HTTPException(status_code=422,
                                detail=f"device_kind must be one of {sorted(IO_DEVICE_KINDS)}")
        where = ["d.device_kind = :device_kind", "d.deleted_at IS NULL"]
        params["device_kind"] = device_kind

    if site_code:
        site = get_site(site_code)
        if site is None:
            raise HTTPException(status_code=404, detail=f"site_code '{site_code}' not found")
        where.append("d.edge_id = :edge_id")
        params["edge_id"] = site["edge_id"]

    where_sql = " AND ".join(where)
    sql = text(f"""
        SELECT d.device_id, d.device_kind, d.edge_id, d.display_name, d.remark_desc,
               d.created_at, d.updated_at
        FROM ems_device d
        WHERE {where_sql}
        ORDER BY d.edge_id, d.device_id
    """)
    rows = (await db.execute(sql, params)).fetchall()

    return {
        "devices": [
            {
                "device_id": r[0],
                "device_kind": r[1],
                "edge_id": r[2],
                "site_code": EDGE_TO_SITE.get(r[2]),
                "display_name": r[3],
                "remark_desc": r[4],
                "created_at": r[5].isoformat() if r[5] else None,
                "updated_at": r[6].isoformat() if r[6] else None,
            }
            for r in rows
        ],
        "total": len(rows),
    }


@router.get("/devices/{device_id}/status")
async def get_device_status(
    device_id: str = Path(...),
    db: AsyncSession = Depends(get_db),
):
    """即時 DI 狀態 + DO state.

    vault SSOT §4.5 期望：FC03 read holding register @ 0x0000 → 16-bit mask → 16 bool channels

    ⚠️ Stub：trx_io_reading 未 ingest（M-PM-245 §A 升報 #1）→ 回 placeholder + 提示.
    P10C 補 ingest 後改為 SELECT latest value from trx_io_reading.
    """
    row = (await db.execute(text("""
        SELECT device_id, device_kind, edge_id, display_name
        FROM ems_device
        WHERE device_id = :device_id AND deleted_at IS NULL
    """), {"device_id": device_id})).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail=f"device_id '{device_id}' not found")
    if row[1] not in IO_DEVICE_KINDS:
        raise HTTPException(status_code=422,
                            detail=f"device_id '{device_id}' is not an I/O device (kind={row[1]})")

    return {
        "device_id": device_id,
        "device_kind": row[1],
        "edge_id": row[2],
        "site_code": EDGE_TO_SITE.get(row[2]),
        "display_name": row[3],
        "channels": None,  # TODO: P10C ingest trx_io_reading 後填 {ch_1: bool, ...}
        "data_source": "pending_ingest",
        "ts": None,
        "note": (
            "trx_io_reading ingest pipeline 待 P10C 補（M-PM-245 §A 升報 #1）"
            "；補完後本 endpoint 回真實 DI/DO state."
        ),
    }


@router.get("/devices/{device_id}/channels")
async def get_device_channels(
    device_id: str = Path(...),
    db: AsyncSession = Depends(get_db),
):
    """列 device 16 channel + 業務命名（從 vault SSOT join）.

    回 channel mapping per device（DI 16 或 DO 16）；業務命名留 admin-ui display layer。
    """
    row = (await db.execute(text("""
        SELECT device_id, device_kind, edge_id, display_name
        FROM ems_device
        WHERE device_id = :device_id AND deleted_at IS NULL
    """), {"device_id": device_id})).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail=f"device_id '{device_id}' not found")
    if row[1] not in IO_DEVICE_KINDS:
        raise HTTPException(status_code=422,
                            detail=f"device_id '{device_id}' is not an I/O device (kind={row[1]})")

    circuits = get_circuits(row[1])
    if circuits is None:
        raise HTTPException(status_code=500,
                            detail=f"device_kind '{row[1]}' has no circuits in DEVICE_MODEL_CIRCUITS")

    return {
        "device_id": device_id,
        "device_kind": row[1],
        "edge_id": row[2],
        "site_code": EDGE_TO_SITE.get(row[2]),
        "channels": circuits,
        "channel_count": len(circuits),
    }


# ============================================================================
# §2.1.6: DO control（3 Guard logic + ems_commands dispatch）
# ============================================================================


class ControlBody(BaseModel):
    state: bool = Field(..., description="True = ON / False = OFF")
    actor: str = Field("admin", description="who issued the control")
    reason: str | None = Field(None, description="optional reason memo")
    skip_guards: bool = Field(False, description="dev/test 用；prod 業主不建議")


@router.post("/devices/{device_id}/channels/{channel}/control")
async def control_do(
    device_id: str = Path(...),
    channel: int = Path(..., ge=1, le=16),
    body: ControlBody = Body(...),
    db: AsyncSession = Depends(get_db),
):
    """DO ON/OFF 控制（含 3 Guard；派 ems_commands command_type='io.do.set'）.

    vault SSOT §4.5.2 3 Guard：
      Guard 1: 該風扇 DI 自動 = ON（手動模式 UI 禁操作）
      Guard 2: 該風扇 DI 過載 = OFF + active alarm acknowledged（無 pending alarm 才放行）
      Guard 3: channel 接線（vault SSOT 場域配置）

    ⚠️ M-PM-245 §A 升報 #1：Guard 1 + Guard 2 完整實作需要 trx_io_reading 即時 DI state；
    本卷 stub fallback：trx_io_reading 沒 ingest 時 Guard 1/2 pass-through（記 audit log
    `guard_skipped=true`）；P10C 補 ingest 後 P12A 第二輪補完整 logic.

    Guard 3 用既有 ems_device + IO_DEVICE_KINDS check；本卷可動.

    成功則派 ems_commands command_type='io.do.set'；Edge worker pull 後執行 driver.write_do.
    """
    # === 採證 device ===
    row = (await db.execute(text("""
        SELECT device_id, device_kind, edge_id, display_name
        FROM ems_device
        WHERE device_id = :device_id AND deleted_at IS NULL
    """), {"device_id": device_id})).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail={"error": "device_not_found",
                                                     "message": f"device_id '{device_id}'"})
    device_kind = row[1]
    edge_id = row[2]

    # === Guard 3: channel 接線 + device 必為 DO 模組 ===
    if device_kind != "tcs300b04_do":
        raise HTTPException(status_code=422, detail={
            "error": "device_kind_mismatch",
            "message": f"control DO requires tcs300b04_do; got '{device_kind}'",
        })

    # === Guard 1+2: DI state 採證（pending P10C ingest）===
    guards_status: dict[str, Any] = {
        "guard_1_auto_mode": "skipped_pending_ingest",
        "guard_2_overload_check": "skipped_pending_ingest",
        "guard_3_channel_connected": "passed",
    }
    if not body.skip_guards:
        # TODO: P10C 補 trx_io_reading 後改為:
        #   di_state = await _read_latest_di_state(db, di_device_id, di_channel)
        #   if not di_state["auto"]: raise 403 fan_not_auto_mode
        #   if di_state["overload"]: raise 403 fan_overload
        #   if active_alarm and not acked: raise 403 alarm_pending_ack
        log.warning(
            "[M-PM-245 §A 升報 #1] DI Guard 1/2 skipped pending P10C trx_io_reading ingest "
            "(device_id=%s channel=%d state=%s)", device_id, channel, body.state
        )

    # === 派 ems_commands command_type='io.do.set' ===
    payload = {
        "device_id": device_id,
        "channel": channel,
        "state": body.state,
        "fc": 6,  # FC06 Write Single Register
        "register_addr": 0,  # @ 0x0000
        "edge_relay_handler": "relay.set",  # Edge handlers.py dispatch
        "ssot_ref": "vault §4.5.2 DO write FC06 mask",
    }
    command_id = await command_service.create_command(
        db=db,
        edge_id=edge_id,
        device_id=device_id,
        command_type="io.do.set",
        payload=payload,
        priority=8,  # 業主控制動作 high priority
        idempotency_key=None,
        issued_by=body.actor,
    )

    return {
        "success": True,
        "command_id": command_id,
        "device_id": device_id,
        "channel": channel,
        "state_requested": body.state,
        "guards": guards_status,
        "edge_id": edge_id,
        "site_code": EDGE_TO_SITE.get(edge_id),
        "note": (
            "command queued; Edge worker pull 後執行 driver.write_do。"
            "⚠️ Edge RelayController 目前 MOCK；M-PM-245 §A 升報 #2；P10C/P13 補實體後生效。"
        ),
    }


# ============================================================================
# §2.1.7~§2.1.10: alarms（複用 ems_alert_active / history）
# ============================================================================


@router.get("/alarms")
async def list_active_alarms(
    site_code: str | None = Query(None),
    db: AsyncSession = Depends(get_db),
):
    """列 active alarms（device_kind ∈ tcs300b03_di / tcs300b04_do）.

    複用 ems_alert_active；不新建 trx_io_alarm（schema 已含 acked_at/by/note）。
    """
    where = ["a.status = 'active'", "d.device_kind = ANY(:io_kinds)", "d.deleted_at IS NULL"]
    params: dict[str, Any] = {"io_kinds": list(IO_DEVICE_KINDS)}
    if site_code:
        site = get_site(site_code)
        if site is None:
            raise HTTPException(status_code=404, detail=f"site_code '{site_code}' not found")
        where.append("a.edge_id = :edge_id")
        params["edge_id"] = site["edge_id"]

    where_sql = " AND ".join(where)
    sql = text(f"""
        SELECT a.alert_id, a.rule_id, a.device_id, a.edge_id, a.severity, a.status,
               a.triggered_at, a.trigger_value, a.trigger_metric, a.message,
               a.last_value, a.last_seen_at, a.acked_by, a.acked_at, a.ack_note,
               d.device_kind, d.display_name, r.rule_name, r.category
        FROM ems_alert_active a
        JOIN ems_device d ON a.device_id = d.device_id
        LEFT JOIN ems_alert_rule r ON a.rule_id = r.rule_id
        WHERE {where_sql}
        ORDER BY a.triggered_at DESC
    """)
    rows = (await db.execute(sql, params)).fetchall()

    return {
        "alarms": [
            {
                "alarm_id": r[0],
                "rule_id": r[1],
                "device_id": r[2],
                "edge_id": r[3],
                "site_code": EDGE_TO_SITE.get(r[3]),
                "severity": r[4],
                "status": r[5],
                "triggered_at": r[6].isoformat() if r[6] else None,
                "trigger_value": r[7],
                "trigger_metric": r[8],
                "message": r[9],
                "last_value": r[10],
                "last_seen_at": r[11].isoformat() if r[11] else None,
                "acked_by": r[12],
                "acked_at": r[13].isoformat() if r[13] else None,
                "ack_note": r[14],
                "device_kind": r[15],
                "display_name": r[16],
                "rule_name": r[17],
                "category": r[18],
            }
            for r in rows
        ],
        "total": len(rows),
    }


@router.get("/alarms/history")
async def list_alarm_history(
    site_code: str | None = Query(None),
    limit: int = Query(100, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    """歷史 alarm（含 resolved / acknowledged events from ems_alert_history）."""
    where = ["d.device_kind = ANY(:io_kinds)", "d.deleted_at IS NULL"]
    params: dict[str, Any] = {"io_kinds": list(IO_DEVICE_KINDS), "limit": limit}
    if site_code:
        site = get_site(site_code)
        if site is None:
            raise HTTPException(status_code=404, detail=f"site_code '{site_code}' not found")
        where.append("h.edge_id = :edge_id")
        params["edge_id"] = site["edge_id"]
    where_sql = " AND ".join(where)
    sql = text(f"""
        SELECT h.ts, h.alert_id, h.rule_id, h.event_type, h.device_id, h.edge_id,
               h.value, h.message, h.severity, h.actor, h.note,
               d.device_kind, d.display_name
        FROM ems_alert_history h
        JOIN ems_device d ON h.device_id = d.device_id
        WHERE {where_sql}
        ORDER BY h.ts DESC
        LIMIT :limit
    """)
    rows = (await db.execute(sql, params)).fetchall()
    return {
        "events": [
            {
                "ts": r[0].isoformat() if r[0] else None,
                "alarm_id": r[1],
                "rule_id": r[2],
                "event_type": r[3],
                "device_id": r[4],
                "edge_id": r[5],
                "site_code": EDGE_TO_SITE.get(r[5]),
                "value": r[6],
                "message": r[7],
                "severity": r[8],
                "actor": r[9],
                "note": r[10],
                "device_kind": r[11],
                "display_name": r[12],
            }
            for r in rows
        ],
        "total": len(rows),
    }


@router.get("/alarms/{alarm_id}")
async def get_alarm(
    alarm_id: int = Path(..., ge=1),
    db: AsyncSession = Depends(get_db),
):
    """alarm 詳情（從 ems_alert_active；若已 resolved 則查 history）."""
    row = (await db.execute(text("""
        SELECT a.alert_id, a.rule_id, a.device_id, a.edge_id, a.severity, a.status,
               a.triggered_at, a.trigger_value, a.trigger_metric, a.message,
               a.last_value, a.last_seen_at, a.acked_by, a.acked_at, a.ack_note,
               a.notifications_sent, d.device_kind, d.display_name, r.rule_name, r.category
        FROM ems_alert_active a
        LEFT JOIN ems_device d ON a.device_id = d.device_id
        LEFT JOIN ems_alert_rule r ON a.rule_id = r.rule_id
        WHERE a.alert_id = :alarm_id
    """), {"alarm_id": alarm_id})).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail=f"alarm_id {alarm_id} not found")
    return {
        "alarm_id": row[0], "rule_id": row[1],
        "device_id": row[2], "edge_id": row[3],
        "site_code": EDGE_TO_SITE.get(row[3]),
        "severity": row[4], "status": row[5],
        "triggered_at": row[6].isoformat() if row[6] else None,
        "trigger_value": row[7], "trigger_metric": row[8],
        "message": row[9],
        "last_value": row[10],
        "last_seen_at": row[11].isoformat() if row[11] else None,
        "acked_by": row[12],
        "acked_at": row[13].isoformat() if row[13] else None,
        "ack_note": row[14],
        "notifications_sent": row[15],
        "device_kind": row[16], "display_name": row[17],
        "rule_name": row[18], "category": row[19],
    }


class AckBody(BaseModel):
    acked_by: str = Field(..., min_length=1)
    ack_note: str | None = Field(None, max_length=1000)


@router.post("/alarms/{alarm_id}/ack")
async def ack_alarm(
    alarm_id: int = Path(..., ge=1),
    body: AckBody = Body(...),
    db: AsyncSession = Depends(get_db),
):
    """業主手動 ack alarm（vault SSOT §4.5.3.5 解鎖條件 2 of 2）.

    解鎖兩條件 AND：
      (1) DI 過載 = OFF（硬體層；ingest 採證；本 endpoint 不直接驗 — 留 control endpoint Guard 2 判）
      (2) acknowledged_at IS NOT NULL ✅（本 endpoint 完成即兌現）

    對齊 v1_alerts.py acknowledge_alert pattern；idempotent.
    """
    # 1. 查現況（restrict 到 IO scope）
    row = (await db.execute(text("""
        SELECT a.alert_id, a.rule_id, a.device_id, a.edge_id, a.severity, a.status,
               a.acked_by, a.acked_at, a.ack_note, d.device_kind
        FROM ems_alert_active a
        JOIN ems_device d ON a.device_id = d.device_id
        WHERE a.alert_id = :alarm_id AND d.device_kind = ANY(:io_kinds)
    """), {"alarm_id": alarm_id, "io_kinds": list(IO_DEVICE_KINDS)})).fetchone()

    if row is None:
        raise HTTPException(status_code=404,
                            detail=f"IO alarm_id {alarm_id} not found in ems_alert_active")

    (existing_alarm_id, rule_id, device_id, edge_id, severity, status,
     existing_acked_by, existing_acked_at, existing_ack_note, device_kind) = row

    # 2. 已 acked → idempotent
    if status == "acknowledged":
        return {
            "alarm_id": existing_alarm_id,
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
        WHERE alert_id = :alarm_id
        RETURNING acked_at
    """), {
        "alarm_id": alarm_id,
        "acked_by": body.acked_by,
        "ack_note": body.ack_note,
    })).fetchone()

    await db.execute(text("""
        INSERT INTO ems_alert_history
            (ts, alert_id, rule_id, event_type, device_id, edge_id,
             severity, actor, note)
        VALUES
            (NOW(), :alarm_id, :rule_id, 'acknowledged',
             :device_id, :edge_id, :severity, :actor, :note)
    """), {
        "alarm_id": alarm_id, "rule_id": rule_id,
        "device_id": device_id, "edge_id": edge_id,
        "severity": severity,
        "actor": body.acked_by,
        "note": body.ack_note,
    })

    await db.commit()

    return {
        "alarm_id": alarm_id,
        "status": "acknowledged",
        "acked_by": body.acked_by,
        "acked_at": update_row[0].isoformat() if update_row and update_row[0] else None,
        "ack_note": body.ack_note,
        "device_id": device_id,
        "edge_id": edge_id,
        "site_code": EDGE_TO_SITE.get(edge_id),
        "device_kind": device_kind,
        "message": "acknowledged",
    }
