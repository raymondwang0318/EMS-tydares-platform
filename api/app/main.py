"""FastAPI application — Tydares EMS Central API Server V2-final (ADR-026)."""

from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import engine
from app.dependencies import get_db
from app.routers import (
    v1_admin,
    v1_admin_alarms,
    v1_admin_events,
    v1_admin_fleet,
    v1_admin_ingest,
    v1_admin_io,
    v1_admin_users,
    v1_alerts,
    v1_auth,
    v1_boss,
    v1_circuits,
    v1_commands,
    v1_edge,
    v1_health,
    v1_ingest,
    v1_reports,
    v1_thermal,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    await engine.dispose()


app = FastAPI(
    title="Tydares EMS Central API",
    description="""Tydares EMS Central API — V2-final (ADR-026)

## 架構（一波到位）
- **Edge ↔ Central（/v1/edge/*, /v1/ingest/*, /v1/commands/{edge_id}, /v1/edges/{edge_id}/*）**
- **UI ↔ Central（/v1/admin/*, /v1/reports/*, /v1/commands）**

## Edge 認證（ADR-021 / ADR-026）
- Layer 1：`POST /v1/edge/enroll`（首次上線）
- Layer 2：`X-Edge-Fingerprint` header（每次呼叫）
- Layer 3：pending_replace / approved / maintenance / revoked 狀態機

## Config Pull 機制（ADR-026 DR-026-04）
- `GET /v1/edges/{edge_id}/desired-config` — Edge 拉目前期望配置
- `POST /v1/edges/{edge_id}/config/ack` — 回報套用結果

## 相關
- ADR-019：自建 Central 平台
- ADR-021：Edge 三層身份識別
- ADR-026：VM104 × Edge V2-final 精煉決議
    """,
    version="2.0.0-final",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- V1 routers（ADR-026） ---
app.include_router(v1_health.router)
app.include_router(v1_edge.router)
app.include_router(v1_ingest.router)
app.include_router(v1_commands.router)
app.include_router(v1_auth.router)   # M-PM-309 登入（不掛 verify_admin_token）
app.include_router(v1_admin.router)
app.include_router(v1_admin_io.router)
app.include_router(v1_admin_alarms.router)
app.include_router(v1_admin_events.router)
app.include_router(v1_admin_users.router)   # 用戶管理（2026-06-11）
app.include_router(v1_admin_fleet.router)   # Fleet 健康 + ECSU 綁定全掃（M-PM-328 軌1）
app.include_router(v1_admin_ingest.router)  # 雙 channel 消化率（M-PM-345 §六 P12A 配套）
app.include_router(v1_boss.router)
app.include_router(v1_circuits.router)
app.include_router(v1_reports.router)
app.include_router(v1_alerts.router)
app.include_router(v1_thermal.router)   # M-PM-341 議題C 熱力圖 Open View（public，不掛 verify_admin_token）


# --- 容器 healthcheck（M-PM-335 §3.4）：查 DB 確認真實健康 ---
# docker-compose healthcheck 打 GET /health；DB 連得上→200、DB down→503→容器 unhealthy 可被偵測。
# 修正 M-PM-334 根因：舊 /health 被下方 serve_frontend catch-all 接、回 index.html 永遠 200，
# 導致 DB down 3 天卻顯示 healthy。須在 serve_frontend（/{full_path}）之前註冊才會匹配。
@app.get("/health")
async def health_check(db: AsyncSession = Depends(get_db)):
    try:
        await db.execute(text("SELECT 1"))
        return {"status": "healthy", "db": "connected"}
    except Exception:
        raise HTTPException(status_code=503, detail="DB unavailable")


# --- Serve React UI static files (no nginx needed) ---

STATIC_DIR = Path(__file__).parent.parent / "static"
EMS_DIR = STATIC_DIR / "ems"
ADMIN_DIR = STATIC_DIR / "admin"

API_PREFIXES = ("v1", "docs", "openapi.json", "redoc")


if ADMIN_DIR.exists():
    app.mount("/admin-ui/assets", StaticFiles(directory=ADMIN_DIR / "assets"), name="admin-assets")

    @app.get("/admin-ui/{full_path:path}")
    async def serve_admin(full_path: str):
        file_path = ADMIN_DIR / full_path
        if file_path.exists() and file_path.is_file():
            return FileResponse(file_path)
        return FileResponse(ADMIN_DIR / "index.html")


if EMS_DIR.exists():
    app.mount("/assets", StaticFiles(directory=EMS_DIR / "assets"), name="ems-assets")

    @app.get("/{full_path:path}")
    async def serve_frontend(request: Request, full_path: str):
        if full_path.startswith(API_PREFIXES):
            # M-PM-137 fix: 不存在的 /v1/* 路徑必須 raise 404，
            # 避免 return None 被 FastAPI 序列化為 null + 200（silent null bug）
            raise HTTPException(status_code=404, detail="Not Found")
        file_path = EMS_DIR / full_path
        if file_path.exists() and file_path.is_file():
            return FileResponse(file_path)
        return FileResponse(EMS_DIR / "index.html")
