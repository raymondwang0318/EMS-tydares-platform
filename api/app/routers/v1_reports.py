"""V2-final Reports router (ADR-026).

合併舊 10+ report endpoints 為 3 個統一 endpoint：
    GET /v1/reports/energy?granularity=15min|daily|monthly&group_by=device|ecsu&from_ts=&to_ts=
    GET /v1/reports/thermal?mode=latest|trend&device_id=&from_ts=&to_ts=
    GET /v1/reports/events?kind=&severity=&from_ts=&to_ts=&limit=&offset=
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_db, verify_admin_token
from app.schemas.report import (
    EnergyReportResponse,
    EventsReportResponse,
    ThermalReportResponse,
)

router = APIRouter(prefix="/v1/reports", tags=["reports"], dependencies=[Depends(verify_admin_token)])


_CAGG_BY_GRAN = {
    "15min": ("cagg_reading_15min", "bucket_15m"),
    "daily": ("cagg_reading_daily", "bucket_day"),
    "monthly": ("cagg_reading_monthly", "bucket_month"),
}


@router.get("/energy", response_model=EnergyReportResponse)
async def energy_report(
    granularity: str = Query("daily", pattern="^(15min|daily|monthly)$"),
    group_by: str = Query("device", pattern="^(device|ecsu)$"),
    from_ts: str = Query(...),
    to_ts: str = Query(...),
    parameter_code: str = Query("tot_input_active_energy"),
    db: AsyncSession = Depends(get_db),
):
    """能源報表，從 continuous aggregate 查。"""
    view, bucket_col = _CAGG_BY_GRAN[granularity]

    if group_by == "device":
        sql = f"""
            SELECT {bucket_col} AS ts, device_id AS group_key,
                   parameter_code, avg_value, min_value, max_value,
                   first_value, last_value,
                   (last_value - first_value) AS energy_delta
            FROM {view}
            WHERE {bucket_col} >= :from_ts
              AND {bucket_col} <  :to_ts
              AND parameter_code = :param
            ORDER BY {bucket_col}
        """
        rows = (await db.execute(text(sql), {
            "from_ts": from_ts, "to_ts": to_ts, "param": parameter_code
        })).fetchall()
    else:
        # ecsu 分組：需 JOIN ecsu_circuit_assgn
        sql = f"""
            SELECT r.{bucket_col} AS ts,
                   e.ecsu_code AS group_key,
                   r.parameter_code,
                   SUM(r.avg_value * a.sign)  AS avg_value,
                   MIN(r.min_value) AS min_value,
                   MAX(r.max_value) AS max_value,
                   SUM(r.first_value * a.sign) AS first_value,
                   SUM(r.last_value  * a.sign) AS last_value,
                   SUM((r.last_value - r.first_value) * a.sign) AS energy_delta
            FROM {view} r
            JOIN fnd_ecsu_circuit_assgn a
              ON a.device_id = r.device_id AND a.circuit_code = r.circuit_code AND a.enabled
            JOIN fnd_ecsu e ON e.ecsu_id = a.ecsu_id
            WHERE r.{bucket_col} >= :from_ts
              AND r.{bucket_col} <  :to_ts
              AND r.parameter_code = :param
            GROUP BY r.{bucket_col}, e.ecsu_code, r.parameter_code
            ORDER BY r.{bucket_col}
        """
        rows = (await db.execute(text(sql), {
            "from_ts": from_ts, "to_ts": to_ts, "param": parameter_code
        })).fetchall()

    points = [
        {
            "ts": row[0].isoformat() if row[0] else "",
            "group_key": row[1],
            "parameter_code": row[2],
            "avg_value": float(row[3]) if row[3] is not None else None,
            "min_value": float(row[4]) if row[4] is not None else None,
            "max_value": float(row[5]) if row[5] is not None else None,
            "first_value": float(row[6]) if row[6] is not None else None,
            "last_value": float(row[7]) if row[7] is not None else None,
            "energy_delta": float(row[8]) if row[8] is not None else None,
        }
        for row in rows
    ]
    return EnergyReportResponse(
        granularity=granularity, group_by=group_by,
        from_ts=from_ts, to_ts=to_ts, points=points,
    )


@router.get("/thermal", response_model=ThermalReportResponse)
async def thermal_report(
    mode: str = Query("latest", pattern="^(latest|trend)$"),
    device_id: str | None = None,
    from_ts: str | None = None,
    to_ts: str | None = None,
    db: AsyncSession = Depends(get_db),
):
    if mode == "latest":
        sql = """
            SELECT DISTINCT ON (device_id, parameter_code)
                   device_id, parameter_code, value, ts
            FROM trx_reading
            WHERE parameter_code IN ('max_temp','min_temp','avg_temp')
              AND (:dev IS NULL OR device_id = :dev)
            ORDER BY device_id, parameter_code, ts DESC
        """
        rows = (await db.execute(text(sql), {"dev": device_id})).fetchall()
        items = [
            {
                "device_id": r[0],
                "parameter_code": r[1],
                "value": float(r[2]),
                "ts": r[3].isoformat(),
            }
            for r in rows
        ]
    else:
        sql = """
            SELECT bucket_day, device_id, parameter_code, daily_max, daily_min, daily_avg
            FROM cagg_thermal_daily
            WHERE bucket_day >= :from_ts AND bucket_day < :to_ts
              AND (:dev IS NULL OR device_id = :dev)
            ORDER BY bucket_day
        """
        rows = (await db.execute(text(sql), {
            "from_ts": from_ts, "to_ts": to_ts, "dev": device_id
        })).fetchall()
        items = [
            {
                "bucket_day": r[0].isoformat() if r[0] else "",
                "device_id": r[1],
                "parameter_code": r[2],
                "daily_max": float(r[3]) if r[3] is not None else None,
                "daily_min": float(r[4]) if r[4] is not None else None,
                "daily_avg": float(r[5]) if r[5] is not None else None,
            }
            for r in rows
        ]
    return ThermalReportResponse(mode=mode, items=items)


@router.get("/events", response_model=EventsReportResponse)
async def events_report(
    kind: str | None = None,
    severity: str | None = None,
    edge_id: str | None = None,
    device_id: str | None = None,
    from_ts: str | None = None,
    to_ts: str | None = None,
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
):
    where = []
    params: dict[str, object] = {}
    if kind:
        where.append("event_kind = :kind"); params["kind"] = kind
    if severity:
        where.append("severity = :severity"); params["severity"] = severity
    if edge_id:
        where.append("edge_id = :edge_id"); params["edge_id"] = edge_id
    if device_id:
        where.append("device_id = :device_id"); params["device_id"] = device_id
    if from_ts:
        where.append("ts >= :from_ts"); params["from_ts"] = from_ts
    if to_ts:
        where.append("ts < :to_ts"); params["to_ts"] = to_ts
    where_sql = ("WHERE " + " AND ".join(where)) if where else ""

    count_sql = f"SELECT COUNT(*) FROM ems_events {where_sql}"
    total = (await db.execute(text(count_sql), params)).scalar_one()

    items_sql = f"""
        SELECT event_id, ts, event_kind, severity, edge_id, device_id, command_id,
               actor, message, data_json
        FROM ems_events {where_sql}
        ORDER BY ts DESC
        LIMIT :limit OFFSET :offset
    """
    params_with_page = {**params, "limit": limit, "offset": offset}
    rows = (await db.execute(text(items_sql), params_with_page)).fetchall()
    items = [
        {
            "event_id": r[0],
            "ts": r[1].isoformat(),
            "event_kind": r[2],
            "severity": r[3],
            "edge_id": r[4],
            "device_id": r[5],
            "command_id": r[6],
            "actor": r[7],
            "message": r[8],
            "data_json": r[9],
        }
        for r in rows
    ]
    return EventsReportResponse(kind=kind, total=total, items=items)
