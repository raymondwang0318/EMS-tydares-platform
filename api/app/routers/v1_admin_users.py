"""V2-final admin 用戶管理 API（M-PM-309 後續：完善使用者管理，老王 2026-06-11 派工）.

endpoints（prefix /v1/admin/users，全掛 verify_admin_token；viewer 唯讀由
dependencies 單點擋非 GET）：
  GET    /                 列表（含最後登入時間 / 線上 session 數）
  POST   /                 新增用戶 {username, password, role}
  PATCH  /{user_id}        改 role / is_active / 重設密碼（擇一或多）
  DELETE /{user_id}        刪除（session CASCADE）

防鎖死護欄：
  - 不可停用 / 刪除 / 降級「自己」（避免把自己鎖在門外）
  - 不可停用 / 刪除 / 降級「最後一個 active admin」（系統永遠至少留一把鑰匙）
  - 停用 / 重設密碼 / 降級 → 立刻清除該用戶 session（即時生效）

稽核：全部操作寫 ems_events（operation，actor=操作者，中文 message）。
"""

from __future__ import annotations

import asyncio
from typing import Optional

import bcrypt
from fastapi import APIRouter, Body, Depends, HTTPException, Path
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_current_admin, get_db, verify_admin_token

router = APIRouter(
    prefix="/v1/admin/users",
    tags=["admin-users"],
    dependencies=[Depends(verify_admin_token)],
)

VALID_ROLES = ("admin", "viewer")
MIN_PASSWORD_LEN = 8


class UserCreate(BaseModel):
    username: str = Field(..., min_length=1, max_length=64)
    password: str = Field(..., min_length=MIN_PASSWORD_LEN, max_length=128)
    role: str = Field("admin", max_length=16)
    can_control_io: bool = Field(False, description="I/O 控制權（操作 relay/DO 實體繼電器）；viewer+TRUE=現場操作員")


class UserUpdate(BaseModel):
    role: Optional[str] = Field(None, max_length=16)
    is_active: Optional[bool] = None
    password: Optional[str] = Field(None, min_length=MIN_PASSWORD_LEN, max_length=128)
    can_control_io: Optional[bool] = None


def _user_row(r) -> dict:
    return {
        "user_id": r["user_id"],
        "username": r["username"],
        "role": r["role"],
        "can_control_io": r["can_control_io"],
        "is_active": r["is_active"],
        "created_at": r["created_at"].isoformat() if r["created_at"] else None,
        "updated_at": r["updated_at"].isoformat() if r["updated_at"] else None,
        "last_login_at": r["last_login_at"].isoformat() if r["last_login_at"] else None,
        "active_sessions": r["active_sessions"],
    }


async def _audit(db: AsyncSession, actor: str, msg: str, severity: str = "info") -> None:
    await db.execute(text("""
        INSERT INTO ems_events (event_kind, severity, source, actor, message)
        VALUES ('operation', :sev, 'admin', :actor, :msg)
    """), {"sev": severity, "actor": actor[:64], "msg": msg})


async def _get_user(db: AsyncSession, user_id: int):
    return (await db.execute(text("""
        SELECT user_id, username, role, is_active, can_control_io
        FROM ems_admin_user WHERE user_id = :id
    """), {"id": user_id})).fetchone()


async def _other_active_admins(db: AsyncSession, exclude_user_id: int) -> int:
    return (await db.execute(text("""
        SELECT COUNT(*) FROM ems_admin_user
        WHERE role = 'admin' AND is_active AND user_id != :id
    """), {"id": exclude_user_id})).scalar_one()


async def _other_active_io_controllers(db: AsyncSession, exclude_user_id: int) -> int:
    return (await db.execute(text("""
        SELECT COUNT(*) FROM ems_admin_user
        WHERE can_control_io AND is_active AND user_id != :id
    """), {"id": exclude_user_id})).scalar_one()


async def _kill_sessions(db: AsyncSession, user_id: int) -> None:
    await db.execute(
        text("DELETE FROM ems_admin_session WHERE user_id = :id"), {"id": user_id})


def _hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


# ===== GET / =====

@router.get("")
async def list_users(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(text("""
        SELECT u.user_id, u.username, u.role, u.can_control_io, u.is_active, u.created_at, u.updated_at,
               s.last_login_at, COALESCE(s.active_sessions, 0) AS active_sessions
        FROM ems_admin_user u
        LEFT JOIN (
            SELECT user_id,
                   MAX(created_at) AS last_login_at,
                   COUNT(*) FILTER (WHERE expires_at > now()) AS active_sessions
            FROM ems_admin_session GROUP BY user_id
        ) s ON s.user_id = u.user_id
        ORDER BY u.user_id
    """))).mappings().all()
    return [_user_row(r) for r in rows]


# ===== POST / =====

@router.post("")
async def create_user(
    body: UserCreate = Body(...),
    me: dict = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    username = body.username.strip()
    if body.role not in VALID_ROLES:
        raise HTTPException(status_code=422, detail=f"role 須為 {VALID_ROLES}")

    password_hash = await asyncio.to_thread(_hash_password, body.password)
    try:
        row = (await db.execute(text("""
            INSERT INTO ems_admin_user (username, password_hash, role, can_control_io)
            VALUES (:u, :h, :r, :cio)
            RETURNING user_id, username, role, can_control_io, is_active, created_at, updated_at
        """), {"u": username, "h": password_hash, "r": body.role,
               "cio": body.can_control_io})).mappings().fetchone()
    except Exception as e:
        if "unique" in str(e).lower() or "duplicate" in str(e).lower():
            raise HTTPException(status_code=409, detail=f"帳號已存在：{username}")
        raise
    await _audit(db, me["username"],
                 f"新增後台用戶 {username}（角色 {body.role}"
                 f"{'＋I/O控制權' if body.can_control_io else ''}，由 {me['username']} 建立）")
    await db.commit()
    return {**dict(row), "created_at": row["created_at"].isoformat(),
            "updated_at": row["updated_at"].isoformat(),
            "last_login_at": None, "active_sessions": 0}


# ===== PATCH /{user_id} =====

@router.patch("/{user_id}")
async def update_user(
    user_id: int = Path(..., ge=1),
    body: UserUpdate = Body(...),
    me: dict = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    if (body.role is None and body.is_active is None and body.password is None
            and body.can_control_io is None):
        raise HTTPException(status_code=422, detail="無更新欄位")
    if body.role is not None and body.role not in VALID_ROLES:
        raise HTTPException(status_code=422, detail=f"role 須為 {VALID_ROLES}")

    target = await _get_user(db, user_id)
    if target is None:
        raise HTTPException(status_code=404, detail=f"用戶 {user_id} 不存在")

    is_self = me["user_id"] == user_id
    demoting = body.role is not None and body.role != "admin" and target[2] == "admin"
    deactivating = body.is_active is False and target[3]

    # 護欄：自己不能自斷後路
    if is_self and (demoting or deactivating):
        raise HTTPException(status_code=400, detail="不可停用或降級自己的帳號（防鎖死）")
    # 護欄：永遠留至少一個 active admin
    if (demoting or deactivating) and target[2] == "admin" and target[3]:
        if await _other_active_admins(db, user_id) == 0:
            raise HTTPException(status_code=400, detail="這是最後一個啟用中的 admin，不可停用或降級（防鎖死）")

    # 護欄：不可關閉最後一個能控 I/O 者（防現場無人能操作風扇；admin 仍可事後自行改回）
    disabling_io = body.can_control_io is False and target[4]
    if disabling_io and await _other_active_io_controllers(db, user_id) == 0:
        raise HTTPException(status_code=400, detail="這是最後一個能控 I/O 的帳號，不可關閉 I/O 控制權")

    sets: list[str] = ["updated_at = now()"]
    params: dict = {"id": user_id}
    changes: list[str] = []
    if body.role is not None and body.role != target[2]:
        sets.append("role = :role"); params["role"] = body.role
        changes.append(f"角色 {target[2]}→{body.role}")
    if body.is_active is not None and body.is_active != target[3]:
        sets.append("is_active = :act"); params["act"] = body.is_active
        changes.append("啟用" if body.is_active else "停用")
    if body.password is not None:
        params["hash"] = await asyncio.to_thread(_hash_password, body.password)
        sets.append("password_hash = :hash")
        changes.append("重設密碼")
    if body.can_control_io is not None and body.can_control_io != target[4]:
        sets.append("can_control_io = :cio"); params["cio"] = body.can_control_io
        changes.append(f"I/O 控制權{'開啟' if body.can_control_io else '關閉'}")

    if not changes:
        return {"user_id": user_id, "changed": []}

    await db.execute(text(
        f"UPDATE ems_admin_user SET {', '.join(sets)} WHERE user_id = :id"), params)

    # 降級 / 停用 / 重設密碼 → 殺該用戶 session 立即生效（自己重設密碼走 /auth/change-password 保留現 session）
    if demoting or deactivating or body.password is not None:
        await _kill_sessions(db, user_id)

    await _audit(db, me["username"],
                 f"後台用戶 {target[1]}：{('、'.join(changes))}（由 {me['username']} 操作）")
    await db.commit()
    return {"user_id": user_id, "changed": changes}


# ===== DELETE /{user_id} =====

@router.delete("/{user_id}")
async def delete_user(
    user_id: int = Path(..., ge=1),
    me: dict = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    target = await _get_user(db, user_id)
    if target is None:
        raise HTTPException(status_code=404, detail=f"用戶 {user_id} 不存在")
    if me["user_id"] == user_id:
        raise HTTPException(status_code=400, detail="不可刪除自己的帳號（防鎖死）")
    if target[2] == "admin" and target[3] and await _other_active_admins(db, user_id) == 0:
        raise HTTPException(status_code=400, detail="這是最後一個啟用中的 admin，不可刪除（防鎖死）")

    await db.execute(
        text("DELETE FROM ems_admin_user WHERE user_id = :id"), {"id": user_id})
    await _audit(db, me["username"],
                 f"刪除後台用戶 {target[1]}（由 {me['username']} 操作）", severity="warn")
    await db.commit()
    return {"deleted": user_id, "username": target[1]}
