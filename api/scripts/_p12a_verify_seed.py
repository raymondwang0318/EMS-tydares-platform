"""M-PM-309 Real Verify 拋棄式測試帳號（驗證後即刪，勿留 production）."""
import asyncio
import sys

import bcrypt
from sqlalchemy import text

sys.path.insert(0, "/app")
from app.database import async_session  # noqa: E402

MODE = sys.argv[1] if len(sys.argv) > 1 else "seed"


async def main() -> None:
    async with async_session() as db:
        if MODE == "seed":
            h = bcrypt.hashpw(b"P12a-Verify-2026!", bcrypt.gensalt()).decode()
            await db.execute(text("""
                INSERT INTO ems_admin_user (username, password_hash)
                VALUES ('p12a_verify', :h)
                ON CONFLICT (username) DO UPDATE SET password_hash = :h, is_active = TRUE
            """), {"h": h})
            print("seeded p12a_verify")
        else:
            res = await db.execute(text(
                "DELETE FROM ems_admin_user WHERE username = 'p12a_verify'"))
            print(f"deleted p12a_verify rows={res.rowcount}")
        await db.commit()


asyncio.run(main())
