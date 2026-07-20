"""V2-final Commands router (ADR-026).

Edge → Central:
    GET  /v1/commands/{edge_id}              — poll
    POST /v1/commands/{command_id}/report    — 合併 status + complete

UI → Central:
    POST /v1/commands
    GET  /v1/commands/history
    GET  /v1/commands/{command_id}
"""

from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_db, verify_admin_token, verify_edge, get_current_admin
from app.services.wakeup_service import send_wakeup
from app.models import EmsCommand, EmsEdge
from app.schemas.command import (
    CommandCreate,
    CommandCreateResponse,
    CommandHistoryResponse,
    CommandItem,
    CommandPollResponse,
    CommandReport,
    CommandReportResponse,
)
from app.services import command_service

router = APIRouter(prefix="/v1", tags=["commands"])

# 實體致動 command_type（需 can_control_io 旗標，不論 admin/viewer）。
# ⚠️ 新增任何「實體繼電器/輸出」類 command_type 必須同步加進此集合，否則會落入 create_command
# 的 else 分支被當管理命令（admin 不需旗標即可下達實體輸出＝把關漏洞）。
# io.do.set 為前瞻保留：Edge ALLOWED_COMMAND_TYPES 尚未註冊 handler，目前實體控制實走 relay.set。
IO_CONTROL_COMMAND_TYPES = frozenset({"relay.set", "io.do.set"})


# --- UI 建立（必須在 /{edge_id} 之前註冊） ---

@router.post("/commands", response_model=CommandCreateResponse)
async def create_command(
    body: CommandCreate,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    me: dict = Depends(get_current_admin),
):
    # === I/O 控制權分流（老王 2026-06-17 後端安全鎖）===
    # /commands 是通用命令入口；relay.set/io.do.set（實體繼電器控制）需 can_control_io，
    # 其餘命令（scan/device.configure 等管理操作）需 admin。改 endpoint 內分流（取代 router
    # method 閘）：viewer+旗標(現場操作員) 能走此入口下 relay；viewer 無旗標 / 下管理命令則擋。
    # get_current_admin 已驗身分（未認證 401）；Bearer 軌 can_control_io=True 維持 service 對接。
    if body.command_type in IO_CONTROL_COMMAND_TYPES:
        if not me.get("can_control_io"):
            raise HTTPException(status_code=403, detail="無 I/O 控制權限（需 can_control_io）")
    elif me.get("role") != "admin":
        raise HTTPException(status_code=403, detail="唯讀帳號（viewer），無法執行此操作")

    command_id = await command_service.create_command(
        db,
        edge_id=body.edge_id,
        device_id=body.device_id,
        command_type=body.command_type,
        payload=body.payload,
        priority=body.priority,
        idempotency_key=body.idempotency_key,
        issued_by=body.issued_by,
    )
    # 通知 Edge 立即拉取（非 fatal：失敗不影響命令流程，Edge 會在下一輪 polling 領取）
    background_tasks.add_task(send_wakeup, body.edge_id)
    return CommandCreateResponse(command_id=command_id)


@router.get("/commands/history", response_model=CommandHistoryResponse, dependencies=[Depends(verify_admin_token)])
async def command_history(
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    status: str | None = None,
    edge_id: str | None = None,
    db: AsyncSession = Depends(get_db),
):
    stmt = select(EmsCommand)
    count_stmt = select(func.count(EmsCommand.command_id))
    if status:
        stmt = stmt.where(EmsCommand.status == status)
        count_stmt = count_stmt.where(EmsCommand.status == status)
    if edge_id:
        stmt = stmt.where(EmsCommand.edge_id == edge_id)
        count_stmt = count_stmt.where(EmsCommand.edge_id == edge_id)

    total = (await db.execute(count_stmt)).scalar_one()
    rows = (await db.execute(
        stmt.order_by(EmsCommand.created_at.desc()).limit(limit).offset(offset)
    )).scalars().all()

    items = [
        CommandItem(
            command_id=r.command_id,
            edge_id=r.edge_id,
            device_id=r.device_id,
            command_type=r.command_type,
            status=r.status,
            payload_json=r.payload_json,
            result_json=r.result_json,
            issued_by=r.issued_by,
            created_at=r.created_at.isoformat(),
            updated_at=r.updated_at.isoformat(),
        )
        for r in rows
    ]
    return CommandHistoryResponse(commands=items, total=total, limit=limit, offset=offset)


# --- UI Command Detail (ScanWizard polling) ---
# M-PM-137 Bug fix: 原本沒這個 endpoint；frontend 呼叫 GET /v1/commands/detail/{cmd_id}
# 落入 main.py catch-all `/{full_path:path}` startswith('v1') return None
# → FastAPI 序列化為 null + HTTP 200 → ScanWizard Step 2 timer 推進但無法進 Step 3
# 路徑兩段 ('detail/{command_id}'); 不會被 single-segment '/commands/{edge_id}' 捕獲

@router.get("/commands/detail/{command_id}", response_model=CommandItem,
            dependencies=[Depends(verify_admin_token)])
async def get_command_detail(
    command_id: str,
    db: AsyncSession = Depends(get_db),
):
    """UI ScanWizard polling: 查單筆 command 狀態 (M-PM-137 補)."""
    cmd = (await db.execute(
        select(EmsCommand).where(EmsCommand.command_id == command_id)
    )).scalar_one_or_none()
    if cmd is None:
        raise HTTPException(status_code=404, detail=f"Command {command_id} not found")
    return CommandItem(
        command_id=cmd.command_id,
        edge_id=cmd.edge_id,
        device_id=cmd.device_id,
        command_type=cmd.command_type,
        status=cmd.status,
        payload_json=cmd.payload_json,
        result_json=cmd.result_json,
        issued_by=cmd.issued_by,
        created_at=cmd.created_at.isoformat(),
        updated_at=cmd.updated_at.isoformat(),
    )


# --- Edge Poll ---

@router.get("/commands/{edge_id}", response_model=CommandPollResponse)
async def poll_commands(
    edge_id: str,
    edge: EmsEdge = Depends(verify_edge),
    db: AsyncSession = Depends(get_db),
):
    if edge.edge_id != edge_id:
        raise HTTPException(status_code=403, detail="edge_id mismatch with token")
    commands = await command_service.poll_commands(db, edge_id, limit=10)
    return CommandPollResponse(commands=commands)


# --- Edge Report (合併 status + complete) ---

@router.post("/commands/{command_id}/report", response_model=CommandReportResponse)
async def report_command(
    command_id: str,
    body: CommandReport,
    edge: EmsEdge = Depends(verify_edge),
    db: AsyncSession = Depends(get_db),
):
    if body.edge_id != edge.edge_id:
        raise HTTPException(status_code=403, detail="edge_id mismatch with token")
    ok = await command_service.report_command(
        db,
        command_id=command_id,
        edge_id=edge.edge_id,
        status=body.status,
        terminal=body.terminal,
        result=body.result,
        error=body.error,
    )
    if not ok:
        raise HTTPException(status_code=400, detail="invalid status transition or command")
    return CommandReportResponse(status="ok")
