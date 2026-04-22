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
