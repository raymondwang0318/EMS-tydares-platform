"""V2-final Ingest router (ADR-026)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_db, verify_edge
from app.models import EmsEdge
from app.schemas.ingest import IngestRequest, IngestResponse
from app.services import ingest_service

router = APIRouter(prefix="/v1", tags=["ingest"])


@router.post("/ingest/{device_id}", response_model=IngestResponse, status_code=202)
async def ingest(
    device_id: str,
    body: IngestRequest,
    edge: EmsEdge = Depends(verify_edge),
    db: AsyncSession = Depends(get_db),
):
    """一般電力資料上報。"""
    if body.edge_id != edge.edge_id:
        raise HTTPException(status_code=403, detail="edge_id mismatch with token")
    accepted, duplicated = await ingest_service.store_records(
        db, edge_id=edge.edge_id, device_id=device_id, records=body.records
    )
    return IngestResponse(status="accepted", accepted=accepted, duplicated=duplicated)


@router.post("/ingest/thermal/{device_id}", response_model=IngestResponse, status_code=202)
async def ingest_thermal(
    device_id: str,
    body: IngestRequest,
    edge: EmsEdge = Depends(verify_edge),
    db: AsyncSession = Depends(get_db),
):
    """熱像彙總上報（接收 summary，raw 影像走 MinIO 不落 DB）。"""
    if body.edge_id != edge.edge_id:
        raise HTTPException(status_code=403, detail="edge_id mismatch with token")
    # source_type 由 payload 自帶；若未指定強制 'ir'
    for rec in body.records:
        if not rec.source_type:
            rec.source_type = "ir"
    accepted, duplicated = await ingest_service.store_records(
        db, edge_id=edge.edge_id, device_id=device_id, records=body.records
    )
    return IngestResponse(status="accepted", accepted=accepted, duplicated=duplicated)
