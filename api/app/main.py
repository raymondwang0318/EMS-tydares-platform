"""FastAPI application — Tydares EMS Central API Server V2-final (ADR-026)."""

from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.database import engine
from app.routers import (
    v1_admin,
    v1_alerts,
    v1_commands,
    v1_edge,
    v1_health,
    v1_ingest,
    v1_reports,
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
app.include_router(v1_admin.router)
app.include_router(v1_reports.router)
app.include_router(v1_alerts.router)


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
            return None
        file_path = EMS_DIR / full_path
        if file_path.exists() and file_path.is_file():
            return FileResponse(file_path)
        return FileResponse(EMS_DIR / "index.html")
