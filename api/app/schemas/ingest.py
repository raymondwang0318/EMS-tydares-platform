"""V2-final Ingest schemas (ADR-026)."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class IngestRecord(BaseModel):
    """一筆資料上報記錄（電力或熱像）。"""
    idemp_key: str = Field(..., description="冪等鍵，Edge 自算")
    ts_ms: int = Field(..., description="量測時間戳（毫秒）")
    source_type: str = Field(..., description="modbus | ir | relay_state")
    payload: dict[str, Any] = Field(..., description="量測內容")
    media_ref: str | None = Field(None, description="大型媒體物件 URL（如 MinIO）")


class IngestRequest(BaseModel):
    edge_id: str
    records: list[IngestRecord]


class IngestResponse(BaseModel):
    status: str
    accepted: int
    duplicated: int
