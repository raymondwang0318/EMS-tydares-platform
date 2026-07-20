"""V2-final FastAPI dependency providers (ADR-026)."""

from __future__ import annotations

import hashlib
from typing import AsyncGenerator

from fastapi import Depends, Header, HTTPException, Request, status
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import async_session
from app.models import EmsEdge


# --- DB session ---

async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with async_session() as session:
        yield session


# --- UI / Admin 驗證（M-PM-309 雙軌：session cookie OR legacy Bearer） ---

ADMIN_SESSION_COOKIE = "ems_session"

_READONLY_SAFE_METHODS = ("GET", "HEAD", "OPTIONS")


def _is_io_control_request(request: Request) -> bool:
    """是否為 I/O 控制 endpoint（control_do：POST .../admin/io/devices/.../control）。

    老王 2026-06-17：viewer+can_control_io=現場操作員（唯讀但能控 I/O）。method 閘對
    viewer 寫操作預設擋（B 類保護），唯獨此路徑放行 viewer 進入，真正權限由 endpoint
    內 can_control_io 旗標把關。POST /commands 的 relay.set 後門因 command_type 在 body、
    method 閘讀不到，改由該 endpoint 內部按 command_type 分流把關（不在此路徑）。
    """
    p = request.url.path
    return (request.method == "POST"
            and p.endswith("/control")
            and "/admin/io/devices/" in p)


async def verify_admin_token(
    request: Request,
    db: AsyncSession = Depends(get_db),
    authorization: str | None = Header(None),
) -> str:
    """Admin / UI 驗證（非 Edge）。

    雙軌（老王 2026-06-05 決策②，transition-safe）：
      1. session cookie（admin-ui 帳密登入；ems_admin_session 24h）
      2. legacy Bearer ∈ AUTH_TOKENS（Pananora / API client / scripts 不破）

    分級管理（用戶管理卷）：role != 'admin'（viewer）的 session 僅允許讀
    （GET/HEAD/OPTIONS），其他 method → 403。Bearer 軌不分級（=admin 全功能）。
    """
    session_id = request.cookies.get(ADMIN_SESSION_COOKIE)
    if session_id:
        row = (await db.execute(text("""
            SELECT u.username, u.role
            FROM ems_admin_session s
            JOIN ems_admin_user u ON u.user_id = s.user_id
            WHERE s.session_id = :sid AND s.expires_at > now() AND u.is_active
        """), {"sid": session_id})).fetchone()
        if row is not None:
            if row[1] != "admin" and request.method not in _READONLY_SAFE_METHODS:
                # viewer 寫操作預設擋（B 類保護）。唯一例外＝I/O 控制 endpoint（control_do）：
                # 放行進入，由 endpoint 內 can_control_io 旗標把關（現場操作員＝唯讀但能控 I/O）。
                if not _is_io_control_request(request):
                    raise HTTPException(status_code=403, detail="唯讀帳號（viewer），無法執行此操作")
            # last_seen 節流更新（60s）：io 頁 1s 輪詢下避免每請求一寫
            res = await db.execute(text("""
                UPDATE ems_admin_session SET last_seen_at = now()
                WHERE session_id = :sid
                  AND last_seen_at < now() - interval '60 seconds'
            """), {"sid": session_id})
            if res.rowcount:
                await db.commit()
            return f"session:{row[0]}"

    if authorization and authorization.startswith("Bearer "):
        token = authorization[7:]
        if token in settings.auth_tokens:
            return token

    raise HTTPException(status_code=401, detail="Not authenticated")


async def get_current_admin(
    request: Request,
    db: AsyncSession = Depends(get_db),
    authorization: str | None = Header(None),
) -> dict:
    """解析目前操作者身份（用戶管理卷：護欄需要知道「自己是誰」）。

    回傳 {user_id, username, role, via}；Bearer 軌 user_id=None（legacy 全功能，
    自我護欄不適用）。掛在已過 verify_admin_token 的 router 內，僅多 1 次 PK 查詢。
    """
    session_id = request.cookies.get(ADMIN_SESSION_COOKIE)
    if session_id:
        row = (await db.execute(text("""
            SELECT u.user_id, u.username, u.role, u.can_control_io
            FROM ems_admin_session s
            JOIN ems_admin_user u ON u.user_id = s.user_id
            WHERE s.session_id = :sid AND s.expires_at > now() AND u.is_active
        """), {"sid": session_id})).fetchone()
        if row is not None:
            return {"user_id": row[0], "username": row[1], "role": row[2],
                    "can_control_io": row[3], "via": "session"}

    if authorization and authorization.startswith("Bearer "):
        token = authorization[7:]
        if token in settings.auth_tokens:
            # Bearer 軌（Pananora/service token）固定 can_control_io=True：維持既有對接不破。
            return {"user_id": None, "username": "api-token", "role": "admin",
                    "can_control_io": True, "via": "bearer"}

    raise HTTPException(status_code=401, detail="Not authenticated")


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
