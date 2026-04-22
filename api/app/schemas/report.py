"""V2-final Report schemas (ADR-026).

報表 API 合併：
- /v1/reports/energy?granularity=15min|daily|monthly&group_by=device|ecsu|site
- /v1/reports/thermal?mode=latest|trend
- /v1/reports/events?kind=comm_abn|operation|command_event
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel


class EnergyPoint(BaseModel):
    ts: str
    group_key: str          # device_id | ecsu_code | site_code
    parameter_code: str
    avg_value: float | None = None
    min_value: float | None = None
    max_value: float | None = None
    first_value: float | None = None
    last_value: float | None = None
    energy_delta: float | None = None     # last - first（累計能量差）


class EnergyReportResponse(BaseModel):
    granularity: str
    group_by: str
    from_ts: str
    to_ts: str
    points: list[EnergyPoint]


class ThermalLatest(BaseModel):
    device_id: str
    ts: str
    max_temp: float | None
    min_temp: float | None
    avg_temp: float | None
    max_coord: list[int] | None = None


class ThermalReportResponse(BaseModel):
    mode: str
    items: list[dict[str, Any]]


class EventItem(BaseModel):
    event_id: int
    ts: str
    event_kind: str
    severity: str
    edge_id: str | None
    device_id: str | None
    command_id: str | None
    actor: str | None
    message: str | None
    data_json: dict[str, Any] | None


class EventsReportResponse(BaseModel):
    kind: str | None
    total: int
    items: list[EventItem]
