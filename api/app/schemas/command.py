"""V2-final Command schemas (ADR-026).

DR-026: 合併 status + complete 成單一 POST /commands/{id}/report。
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


# --- UI → Central 建立指令 ---

class CommandCreate(BaseModel):
    edge_id: str
    device_id: str | None = None
    command_type: str
    payload: dict[str, Any] = Field(default_factory=dict)
    priority: int = 50
    not_before_ts: str | None = None
    expire_ts: str | None = None
    idempotency_key: str | None = None
    issued_by: str | None = None


class CommandCreateResponse(BaseModel):
    command_id: str


# --- Edge Poll（與 Edge command_executor 契約一致）---

class CommandPollItem(BaseModel):
    id: str
    command_type: str
    payload_json: dict[str, Any]


class CommandPollResponse(BaseModel):
    commands: list[CommandPollItem]


# --- Edge Report（合併 status + complete）---

class CommandReport(BaseModel):
    """Edge 回報執行狀態。

    terminal=False: RUNNING 中間狀態
    terminal=True:  final status（SUCCEEDED | FAILED）
    """
    status: str = Field(..., description="RUNNING | SUCCEEDED | FAILED")
    terminal: bool = False
    edge_id: str
    result: dict[str, Any] | None = None
    error: str | None = None


class CommandReportResponse(BaseModel):
    status: str


# --- History / Detail ---

class CommandItem(BaseModel):
    command_id: str
    edge_id: str
    device_id: str | None
    command_type: str
    status: str
    payload_json: dict[str, Any] | None
    result_json: dict[str, Any] | None
    issued_by: str | None
    created_at: str
    updated_at: str


class CommandHistoryResponse(BaseModel):
    commands: list[CommandItem]
    total: int
    limit: int
    offset: int
