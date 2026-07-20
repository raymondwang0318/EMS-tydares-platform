"""Seed / 重設 admin 使用者（M-PM-309 階段2）.

老王在 VM102 容器內互動執行（密碼不經 chat / 不入庫明碼 / 不進 git）：
    docker exec -it ems-api python scripts/seed_admin.py

行為：輸入 username + 密碼（兩次確認）→ bcrypt hash → UPSERT ems_admin_user。
username 已存在 → 更新密碼（重設密碼同一支腳本）。
"""

from __future__ import annotations

import asyncio
import getpass
import sys

import bcrypt
from sqlalchemy import text

sys.path.insert(0, "/app")
from app.database import async_session  # noqa: E402


async def upsert(username: str, password_hash: str) -> str:
    async with async_session() as db:
        row = (await db.execute(text(
            "SELECT user_id FROM ems_admin_user WHERE username = :u"
        ), {"u": username})).fetchone()
        if row is None:
            await db.execute(text("""
                INSERT INTO ems_admin_user (username, password_hash, role, is_active)
                VALUES (:u, :h, 'admin', TRUE)
            """), {"u": username, "h": password_hash})
            action = "建立"
        else:
            await db.execute(text("""
                UPDATE ems_admin_user
                SET password_hash = :h, is_active = TRUE, updated_at = now()
                WHERE username = :u
            """), {"u": username, "h": password_hash})
            action = "更新密碼"
        await db.commit()
        return action


def main() -> None:
    username = input("管理帳號 username: ").strip()
    if not username:
        print("❌ username 不可為空"); sys.exit(1)
    pw1 = getpass.getpass("密碼: ")
    pw2 = getpass.getpass("再輸入一次確認: ")
    if pw1 != pw2:
        print("❌ 兩次密碼不一致"); sys.exit(1)
    if len(pw1) < 8:
        print("❌ 密碼至少 8 碼"); sys.exit(1)

    password_hash = bcrypt.hashpw(pw1.encode(), bcrypt.gensalt()).decode()
    action = asyncio.run(upsert(username, password_hash))
    print(f"✅ admin 使用者 {username} {action}完成；即可在 admin-ui /login 登入")


if __name__ == "__main__":
    main()
