"""Application configuration via environment variables.

Secrets (DATABASE_URL, AUTH_TOKENS) MUST be supplied via environment
(usually from docker-compose env_file -> api/.env). No secret defaults live in
source code — see M-P11-006 + 回執_M-P11-006_PM (選項 A; 2026-04-22).
"""

from __future__ import annotations

import json
from typing import List

from pydantic import Field
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # Database (VM104) — required; no default. Must be set via env DATABASE_URL.
    database_url: str = Field(default="", description="必須由 env DATABASE_URL 注入")

    # Authentication — list of valid Bearer tokens (JSON array string).
    # Required; no default. Must be set via env AUTH_TOKENS.
    auth_tokens: List[str] = Field(default_factory=list, description="env AUTH_TOKENS JSON 注入")

    # Server
    log_level: str = "info"

    # Session cookie domain — 跨子網域同享（M-PM-328 軌3 Pananora 硬模式前置）。
    # 空=host-only（現狀）；設 ".tydares.internal" → 僅該網域主機名登入帶 Domain，
    # IP/LAN 存取（現地 192.168.10.X / 在家 100.70.196.32）維持 host-only 不被擋。
    session_cookie_domain: str = Field(default="", description="env SESSION_COOKIE_DOMAIN；空=host-only")

    # SMTP — mail 通知（M-PM-313 P3）。選填；未設→Mail Worker 略過發送（不報錯）。
    # 由 env 注入（老王階段2 部署時設；不入庫明碼/不進 git）。
    smtp_host: str = Field(default="", description="env SMTP_HOST；空=停用 mail 發送")
    smtp_port: int = Field(default=587, description="env SMTP_PORT")
    smtp_user: str = Field(default="", description="env SMTP_USER")
    smtp_password: str = Field(default="", description="env SMTP_PASSWORD")
    smtp_tls: bool = Field(default=True, description="env SMTP_TLS；STARTTLS")
    mail_from: str = Field(default="", description="env MAIL_FROM；空→fallback smtp_user")

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"

    def parse_auth_tokens(self, v):
        if isinstance(v, str):
            return json.loads(v)
        return v


settings = Settings()

# Fail fast if required secrets are missing — prevents silent fallback to empty
# credentials in production. Pattern owed to M-PM-027 Deploy & Verify principle.
if not settings.database_url:
    raise RuntimeError(
        "DATABASE_URL env var must be set (via api/.env or docker-compose env_file). "
        "See api/.env.example for format."
    )
if not settings.auth_tokens:
    raise RuntimeError(
        "AUTH_TOKENS env var must be set (JSON array of Bearer tokens). "
        "See api/.env.example for format."
    )
