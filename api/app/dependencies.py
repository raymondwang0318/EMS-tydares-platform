"""V2-final FastAPI dependency providers (ADR-026)."""

from __future__ import annotations

import hashlib
from typing import AsyncGenerator

from fastapi import Depends, Header, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import async_session
from app.models import EmsEdge


# --- DB session ---

async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with async_session() as session:
        yield session


# --- UI / Admin token（共用管理 token） ---

async def verify_admin_token(authorization: str = Header(...)) -> str:
    """Admin / UI Bearer token 驗證（非 Edge）。"""
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing Bearer token")
    token = authorization[7:]
    if token not in settings.auth_tokens:
        raise HTTPException(status_code=401, detail="Invalid admin token")
    return token


# --- Edge 身份驗證（ADR-021 三層） ---

def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


async def verify_edge(
    request: Request,
    db: AsyncSession = Depends(get_db),
    authorization: str = Header(...),
    x_edge_fingerprint: str | None = Header(None),
) -> EmsEdge:
    """驗證 Edge 身份（Layer 1 token + Layer 2 fingerprint）。

    回傳 EmsEdge instance 供下游路由使用。
    """
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing Bearer token")
    token = authorization[7:]
    token_hash = _hash_token(token)

    result = await db.execute(select(EmsEdge).where(EmsEdge.token_hash == token_hash))
    edge = result.scalar_one_or_none()
    if edge is None:
        raise HTTPException(status_code=401, detail="Unknown edge token")

    if edge.status == "revoked":
        raise HTTPException(status_code=403, detail="Edge revoked")
    if edge.status == "pending":
        raise HTTPException(status_code=403, detail="Edge pending approval")

    # Layer 2 指紋驗證（approved / maintenance 狀態才檢查）
    if edge.status in ("approved", "maintenance") and edge.fingerprint and x_edge_fingerprint:
        if x_edge_fingerprint != edge.fingerprint:
            # 指紋漂移 → 設為 pending_replace，呼叫方拿到 401 觸發 re-enroll
            edge.status = "pending_replace"
            if edge.fingerprint not in (edge.previous_fingerprints or []):
                edge.previous_fingerprints = (edge.previous_fingerprints or []) + [edge.fingerprint]
            await db.commit()
            raise HTTPException(status_code=401, detail="Fingerprint mismatch — re-enroll required")

    # 更新 last_seen
    edge.last_seen_ip = get_client_ip(request)
    from datetime import datetime, timezone as tz
    edge.last_seen_at = datetime.now(tz.utc)
    await db.commit()

    return edge


def get_client_ip(request: Request) -> str:
    real_ip = request.headers.get("x-real-ip")
    if real_ip:
        return real_ip.strip()
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else "unknown"
