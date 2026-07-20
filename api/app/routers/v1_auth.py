"""V2-final admin-ui 登入 API（M-PM-309 階段2）.

帳密 + session cookie（24h）取代 admin-ui 靜態 Bearer；verify_admin_token 雙軌
（cookie OR Bearer）→ 既有 API 客戶端（Pananora / scripts）不破。
範圍僅 admin-ui 後台維護 UI；Boss / Pananora 前台登入 OUT of scope（老王 2026-06-05 明示）。

endpoints（prefix /v1/admin/auth，**不掛 verify_admin_token**）：
  POST /login   帳密 → bcrypt 驗證 → 建 ems_admin_session → Set-Cookie ems_session
                （HttpOnly + Secure + SameSite=Lax + Max-Age 24h；老王決策①走 HTTPS）
  POST /logout  刪 session + 清 cookie
  GET  /me      cookie → {user:{username, role}}；無 / 過期 401

稽核：登入成功 / 失敗 / 登出寫 ems_events（operation；actor=username；中文 message）。
"""

from __future__ import annotations

import asyncio
import secrets

import bcrypt
from fastapi import APIRouter, Body, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.dependencies import ADMIN_SESSION_COOKIE, get_client_ip, get_db

router = APIRouter(prefix="/v1/admin/auth", tags=["admin-auth"])


def _is_https(request: Request) -> bool:
    """判斷原始請求是否走 HTTPS（nginx 後面看 X-Forwarded-Proto）。"""
    proto = request.headers.get("x-forwarded-proto")
    if proto:
        return proto.split(",")[0].strip().lower() == "https"
    return request.url.scheme == "https"


def _cookie_domain(request: Request) -> str | None:
    """條件式 session cookie domain（M-PM-328 軌3）。

    僅當 request host 以 settings.session_cookie_domain 結尾才設 Domain；否則回 None
    （host-only）。防現地 LAN 192.168.10.X / 在家 Tailscale 100.70.196.32（IP 存取）登入
    被擋——瀏覽器拒絕 Domain 不匹配 request host 的 Set-Cookie（M-P11-E76 §三採證）。
    空 setting＝維持 host-only 現狀（零行為改變）。
    """
    domain = settings.session_cookie_domain.strip()
    if not domain:
        return None
    host = request.url.hostname or ""
    bare = domain.lstrip(".")
    if host == bare or host.endswith("." + bare):
        return domain
    return None


SESSION_TTL_SEC = 24 * 3600

# user 不存在時也跑一次假驗證，抹平帳號枚舉的 timing 差
_DUMMY_HASH = bcrypt.hashpw(b"timing-pad", bcrypt.gensalt()).decode()


class LoginRequest(BaseModel):
    username: str = Field(..., max_length=64)
    password: str = Field(..., max_length=128)


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(..., max_length=128)
    new_password: str = Field(..., min_length=8, max_length=128)


async def _audit(db: AsyncSession, severity: str, actor: str, msg: str) -> None:
    await db.execute(text("""
        INSERT INTO ems_events (event_kind, severity, source, actor, message)
        VALUES ('operation', :sev, 'admin', :actor, :msg)
    """), {"sev": severity, "actor": actor[:64], "msg": msg})


@router.post("/login")
async def login(
    request: Request,
    response: Response,
    body: LoginRequest = Body(...),
    db: AsyncSession = Depends(get_db),
):
    username = body.username.strip()
    row = (await db.execute(text("""
        SELECT user_id, username, password_hash, role, can_control_io
        FROM ems_admin_user
        WHERE username = :u AND is_active
    """), {"u": username})).fetchone()

    # bcrypt 為 CPU-bound → thread（uvicorn 2 worker 事件圈不被卡）
    hash_to_check = row[2] if row else _DUMMY_HASH
    ok = await asyncio.to_thread(
        bcrypt.checkpw, body.password.encode(), hash_to_check.encode()
    )

    if row is None or not ok:
        await _audit(db, "warn", username,
                     f"admin-ui 登入失敗（帳號 {username}，來源 {get_client_ip(request)}）")
        await db.commit()
        raise HTTPException(status_code=401, detail="帳號或密碼錯誤")

    session_id = secrets.token_urlsafe(32)
    await db.execute(text("""
        INSERT INTO ems_admin_session (session_id, user_id, expires_at, ip_hint)
        VALUES (:sid, :uid, now() + interval '24 hours', :ip)
    """), {"sid": session_id, "uid": row[0], "ip": get_client_ip(request)[:64]})
    # 順手清過期 session（避免表無限累積）
    await db.execute(text("DELETE FROM ems_admin_session WHERE expires_at < now()"))
    await _audit(db, "info", row[1],
                 f"admin-ui 登入成功（{row[1]}，來源 {get_client_ip(request)}）")
    await db.commit()

    # Secure 自適應（M-P12-108）：https 入口帶 Secure（決策①完整防護）；
    # http 入口（現地 IP:8080 直開，Pananora 對接既成事實）不帶 Secure 否則瀏覽器拒存 → 登入鬼打牆
    cookie_kwargs = dict(
        key=ADMIN_SESSION_COOKIE, value=session_id,
        max_age=SESSION_TTL_SEC, httponly=True, secure=_is_https(request),
        samesite="lax", path="/",
    )
    domain = _cookie_domain(request)
    if domain:
        cookie_kwargs["domain"] = domain
    response.set_cookie(**cookie_kwargs)
    return {"user": {"username": row[1], "role": row[3], "can_control_io": row[4]}, "via": "session"}


@router.post("/logout")
async def logout(
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    session_id = request.cookies.get(ADMIN_SESSION_COOKIE)
    if session_id:
        row = (await db.execute(text("""
            SELECT u.username
            FROM ems_admin_session s
            JOIN ems_admin_user u ON u.user_id = s.user_id
            WHERE s.session_id = :sid
        """), {"sid": session_id})).fetchone()
        await db.execute(
            text("DELETE FROM ems_admin_session WHERE session_id = :sid"),
            {"sid": session_id})
        if row is not None:
            await _audit(db, "info", row[0], f"admin-ui 登出（{row[0]}）")
        await db.commit()
    response.delete_cookie(ADMIN_SESSION_COOKIE, path="/", domain=_cookie_domain(request))
    return {"ok": True}


@router.post("/change-password")
async def change_password(
    request: Request,
    body: ChangePasswordRequest = Body(...),
    db: AsyncSession = Depends(get_db),
):
    """自助改密碼（用戶管理卷）：驗目前密碼 → 換 hash → 殺其他 session（保留現 session）。

    viewer 也可改自己密碼（本 router 不掛 verify_admin_token，不受唯讀單點限制）。
    """
    session_id = request.cookies.get(ADMIN_SESSION_COOKIE)
    if not session_id:
        raise HTTPException(status_code=401, detail="未登入")
    row = (await db.execute(text("""
        SELECT u.user_id, u.username, u.password_hash
        FROM ems_admin_session s
        JOIN ems_admin_user u ON u.user_id = s.user_id
        WHERE s.session_id = :sid AND s.expires_at > now() AND u.is_active
    """), {"sid": session_id})).fetchone()
    if row is None:
        raise HTTPException(status_code=401, detail="session 過期，請重新登入")

    ok = await asyncio.to_thread(
        bcrypt.checkpw, body.current_password.encode(), row[2].encode())
    if not ok:
        await _audit(db, "warn", row[1],
                     f"admin-ui 改密碼失敗：目前密碼錯誤（{row[1]}，來源 {get_client_ip(request)}）")
        await db.commit()
        raise HTTPException(status_code=400, detail="目前密碼錯誤")

    new_hash = await asyncio.to_thread(
        lambda: bcrypt.hashpw(body.new_password.encode(), bcrypt.gensalt()).decode())
    await db.execute(text("""
        UPDATE ems_admin_user SET password_hash = :h, updated_at = now()
        WHERE user_id = :uid
    """), {"h": new_hash, "uid": row[0]})
    # 殺自己其他裝置的 session（現 session 保留，不用重登）
    await db.execute(text("""
        DELETE FROM ems_admin_session WHERE user_id = :uid AND session_id != :sid
    """), {"uid": row[0], "sid": session_id})
    await _audit(db, "info", row[1],
                 f"admin-ui 改密碼成功（{row[1]}，來源 {get_client_ip(request)}）")
    await db.commit()
    return {"ok": True}


@router.get("/me")
async def me(request: Request, db: AsyncSession = Depends(get_db)):
    session_id = request.cookies.get(ADMIN_SESSION_COOKIE)
    if session_id:
        row = (await db.execute(text("""
            SELECT u.username, u.role, u.can_control_io, s.expires_at
            FROM ems_admin_session s
            JOIN ems_admin_user u ON u.user_id = s.user_id
            WHERE s.session_id = :sid AND s.expires_at > now() AND u.is_active
        """), {"sid": session_id})).fetchone()
        if row is not None:
            return {"user": {"username": row[0], "role": row[1], "can_control_io": row[2]},
                    "via": "session", "expires_at": row[3].isoformat()}

    # Bearer fallback（M-P12-108）：Pananora 前台嵌入 admin-ui 頁面（log 實證
    # /admin-ui/trends iframe），bundle 既載 Bearer → 嵌入頁免登入維持對接不破。
    # 前端只在 iframe（window.self!==top）接受 via=bearer；直接訪客仍走登入閘。
    auth = request.headers.get("authorization", "")
    if auth.startswith("Bearer ") and auth[7:] in settings.auth_tokens:
        return {"user": {"username": "api-token", "role": "admin", "can_control_io": True}, "via": "bearer"}

    raise HTTPException(status_code=401, detail="未登入或 session 過期")
