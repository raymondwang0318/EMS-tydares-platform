"""V2-final Edge Enroll Service (ADR-021 Layer 1 / ADR-026 DR-026-05).

Edge 啟動流程：
1. 若 Edge 本地已有 token（approved 過）→ 走一般 API，無需 enroll
2. 若無 token（首次上線 or 指紋漂移）→ POST /v1/edge/enroll
3. 送 hostname + fingerprint → Central 建立或找到 ems_edge 記錄
4. 狀態為 pending → 等候管理員 approve
5. 核可後 Central 生成 token 寫 token_hash；Edge 拿 GET /v1/edge/enroll/{request_id} 取回明文 token（一次性）
"""

from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import EmsEdge, EmsEvent


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


async def enroll_edge(
    db: AsyncSession,
    edge_id: str | None,
    hostname: str,
    fingerprint: str,
    site_code: str | None,
    claimed_edge_name: str | None,
) -> dict:
    """建立或更新 enroll 請求。

    規則：
    - 若 edge_id 已存在且指紋匹配 → 視為心跳，直接回傳當前狀態
    - 若 edge_id 已存在但指紋不符 → status=pending_replace，記歷史指紋
    - 若 edge_id 為 None 或未存在 → 建立新 pending 記錄
    """
    request_id = str(uuid.uuid4())

    if edge_id:
        result = await db.execute(select(EmsEdge).where(EmsEdge.edge_id == edge_id))
        edge = result.scalar_one_or_none()
    else:
        edge = None

    if edge is None:
        # 新 Edge 註冊
        new_edge_id = edge_id or f"edge-{secrets.token_hex(4)}"
        edge = EmsEdge(
            edge_id=new_edge_id,
            edge_name=claimed_edge_name or new_edge_id,
            site_code=site_code,
            hostname=hostname,
            token_hash="",          # 核可後才生
            fingerprint=fingerprint,
            status="pending",
            registered_at=datetime.now(timezone.utc),
        )
        db.add(edge)
    else:
        # 已存在
        if edge.fingerprint and edge.fingerprint != fingerprint:
            # 指紋漂移
            edge.previous_fingerprints = (edge.previous_fingerprints or []) + [edge.fingerprint]
            edge.fingerprint = fingerprint
            edge.status = "pending_replace"
            edge.hostname = hostname
        elif not edge.fingerprint:
            edge.fingerprint = fingerprint
            edge.hostname = hostname

    # 事件
    db.add(EmsEvent(
        event_kind="edge_lifecycle",
        severity="info",
        edge_id=edge.edge_id,
        actor=hostname,
        message=f"enroll request status={edge.status}",
        data_json={"request_id": request_id, "hostname": hostname},
    ))
    await db.commit()
    await db.refresh(edge)

    return {
        "request_id": request_id,
        "edge_id": edge.edge_id,
        "status": edge.status,
        "token": None,
        "message": "Waiting for admin approval" if edge.status == "pending" else None,
    }


async def get_enroll_status(db: AsyncSession, edge_id: str) -> dict:
    """Edge polling 核可結果。

    若 status=approved 且 token_hash 為空（表示剛 approve 但尚未發 token）→ 發一次 token。
    """
    result = await db.execute(select(EmsEdge).where(EmsEdge.edge_id == edge_id))
    edge = result.scalar_one_or_none()
    if edge is None:
        return {"edge_id": edge_id, "status": "not_found", "token": None}

    token_plain: str | None = None
    # 若剛 approved 但尚無 token_hash → 產 token 並寫入；回給 Edge 一次
    if edge.status == "approved" and not edge.token_hash:
        token_plain = secrets.token_urlsafe(32)
        edge.token_hash = _hash_token(token_plain)
        db.add(EmsEvent(
            event_kind="edge_lifecycle",
            severity="info",
            edge_id=edge.edge_id,
            message="token issued after approval",
        ))
        await db.commit()

    return {
        "edge_id": edge.edge_id,
        "status": edge.status,
        "token": token_plain,
        "approved_at": edge.approved_at.isoformat() if edge.approved_at else None,
    }


async def approve_edge(db: AsyncSession, edge_id: str, approver: str) -> bool:
    """Admin UI 核可 Edge。狀態 pending / pending_replace → approved。"""
    result = await db.execute(select(EmsEdge).where(EmsEdge.edge_id == edge_id))
    edge = result.scalar_one_or_none()
    if edge is None:
        return False
    if edge.status not in ("pending", "pending_replace"):
        return False
    edge.status = "approved"
    edge.approved_at = datetime.now(timezone.utc)
    edge.approved_by = approver
    # 核可代表新一輪 token 需重發 → 清 token_hash 讓 get_enroll_status 發新 token
    edge.token_hash = ""
    db.add(EmsEvent(
        event_kind="edge_lifecycle",
        severity="info",
        edge_id=edge_id,
        actor=approver,
        message="approved",
    ))
    await db.commit()
    return True


async def revoke_edge(db: AsyncSession, edge_id: str, reason: str, actor: str) -> bool:
    result = await db.execute(select(EmsEdge).where(EmsEdge.edge_id == edge_id))
    edge = result.scalar_one_or_none()
    if edge is None:
        return False
    edge.status = "revoked"
    edge.revoked_at = datetime.now(timezone.utc)
    edge.revoked_reason = reason
    edge.token_hash = ""
    db.add(EmsEvent(
        event_kind="edge_lifecycle",
        severity="warn",
        edge_id=edge_id,
        actor=actor,
        message=f"revoked: {reason}",
    ))
    await db.commit()
    return True


async def set_maintenance(db: AsyncSession, edge_id: str, actor: str) -> tuple[bool, str]:
    """approved → maintenance。回傳 (ok, reason_if_fail)。"""
    result = await db.execute(select(EmsEdge).where(EmsEdge.edge_id == edge_id))
    edge = result.scalar_one_or_none()
    if edge is None:
        return False, "edge not found"
    if edge.status != "approved":
        return False, f"cannot enter maintenance from status={edge.status}"
    edge.status = "maintenance"
    edge.maintenance_at = datetime.now(timezone.utc)
    db.add(EmsEvent(
        event_kind="edge_lifecycle",
        severity="info",
        edge_id=edge_id,
        actor=actor,
        message="entered maintenance",
    ))
    await db.commit()
    return True, ""


async def resume_edge(db: AsyncSession, edge_id: str, actor: str) -> tuple[bool, str]:
    """maintenance → approved。回傳 (ok, reason_if_fail)。"""
    result = await db.execute(select(EmsEdge).where(EmsEdge.edge_id == edge_id))
    edge = result.scalar_one_or_none()
    if edge is None:
        return False, "edge not found"
    if edge.status != "maintenance":
        return False, f"cannot resume from status={edge.status}"
    edge.status = "approved"
    edge.maintenance_at = None
    db.add(EmsEvent(
        event_kind="edge_lifecycle",
        severity="info",
        edge_id=edge_id,
        actor=actor,
        message="resumed from maintenance",
    ))
    await db.commit()
    return True, ""
