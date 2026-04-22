"""V2-final Config Pull schemas (ADR-026 DR-026-04)."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


# --- Edge pull desired config ---

class DeviceConfigItem(BaseModel):
    device_id: str
    device_kind: str
    display_name: str | None = None
    enabled: bool = True
    deleted: bool = False
    # Modbus 專屬（device_kind=modbus_meter 時有值）
    modbus: dict[str, Any] | None = None
    # 熱像專屬
    thermal: dict[str, Any] | None = None
    # Model + circuits 定義（驅動用）
    model: dict[str, Any] | None = None


class DesiredConfigResponse(BaseModel):
    edge_id: str
    config_version: int
    config_hash: str = Field(..., description="devices[] 內容的 SHA256，Edge diff 用")
    devices: list[DeviceConfigItem]


# --- Edge ack 套用結果 ---

class ConfigAckRequest(BaseModel):
    applied_version: int
    applied_at: str = Field(..., description="ISO 8601 UTC")
    result: str = Field(..., description="success | partial | failed")
    errors: list[str] | None = None


class ConfigAckResponse(BaseModel):
    status: str
