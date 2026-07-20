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
    # M-PM-345 雙 channel：edge 推送標記 'A'(即時/近 60s) / 'B'(歷史補)。
    # 🔴 向後相容：未開雙 channel 的 fleet（push_once）不帶此欄 → None → Central 原邏輯不變。
    # 供 Central 分別記 A/B 消化率（§六 P12A 配套）；inbox.channel 透傳。
    channel: str | None = Field(None, description="雙 channel 標記 A/B；單軌/legacy 不帶")


class IngestResponse(BaseModel):
    status: str
    accepted: int
    duplicated: int
