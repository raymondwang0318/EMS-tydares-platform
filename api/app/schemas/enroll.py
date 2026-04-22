"""V2-final Edge Enroll schemas (ADR-021 Layer 1 落地 / ADR-026 DR-026-05)."""

from __future__ import annotations

from pydantic import BaseModel, Field


class EnrollRequest(BaseModel):
    """Edge 啟動時向 Central 註冊。

    無預置 token 時啟動：送 hostname + fingerprint，狀態=pending 等待人工核可。
    有預置 token 時啟動：略過 enroll，直接帶 token 走其他 API。
    """
    edge_id: str | None = Field(None, description="可選；若 null 由 Central 分配")
    hostname: str
    fingerprint: str = Field(..., description="硬體指紋 SHA256(machine-id:mac_addr)")
    site_code: str | None = None
    claimed_edge_name: str | None = None


class EnrollResponse(BaseModel):
    request_id: str
    edge_id: str
    status: str                         # pending | approved | pending_replace
    token: str | None = None            # 僅在 approved 時回傳
    message: str | None = None


class EnrollStatusResponse(BaseModel):
    request_id: str
    edge_id: str
    status: str
    token: str | None = None
    approved_at: str | None = None
