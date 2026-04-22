"""Report & analysis API — serves the frontend UI.

Queries for dashboard stats, energy reports, trend analysis, etc.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_db, verify_bearer_token


def _parse_iso_ts(value: Optional[str]) -> Optional[datetime]:
    """Accept ISO 8601 string (date or datetime, with optional trailing Z)."""
    if not value:
        return None
    text_val = value
    if text_val.endswith("Z"):
        text_val = text_val[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(text_val)
    except ValueError:
        # bare date like '2026-04-15'
        return datetime.fromisoformat(text_val + "T00:00:00+00:00")

router = APIRouter(prefix="/reports")


# ---------------------------------------------------------------------------
# Dashboard stats
# ---------------------------------------------------------------------------

@router.get("/dashboard-stats")
async def dashboard_stats(db: AsyncSession = Depends(get_db), _=Depends(verify_bearer_token)):
    results = {}

    r = await db.execute(text("SELECT COALESCE(SUM(total_input_active_energy), 0) FROM trx_all_peripheral_periodical_reading WHERE creation_date >= date_trunc('month', NOW())"))
    results["total_kwh"] = float(r.scalar() or 0)

    r = await db.execute(text("SELECT COUNT(*) FROM ems_edge"))
    results["edge_count"] = r.scalar() or 0

    r = await db.execute(text("SELECT COUNT(*) FROM trx_comm_abn_record WHERE creation_date >= date_trunc('day', NOW())"))
    results["today_alerts"] = r.scalar() or 0

    r = await db.execute(text("""
        SELECT CASE WHEN total > 0 THEN ROUND(success * 100.0 / total, 1) ELSE 0 END
        FROM (
            SELECT COALESCE(SUM(total_polls), 0) as total, COALESCE(SUM(success_polls), 0) as success
            FROM trx_comm_success_rate_daily WHERE rate_date >= date_trunc('day', NOW())
        ) t
    """))
    results["comm_rate"] = float(r.scalar() or 0)

    return results


# ---------------------------------------------------------------------------
# Realtime report (ECSU live data)
# ---------------------------------------------------------------------------

@router.get("/realtime")
async def realtime_report(db: AsyncSession = Depends(get_db), _=Depends(verify_bearer_token)):
    result = await db.execute(text("""
        SELECT ecsu_id, ecsu_code_1 as building, ecsu_code_3 as room, ecsu_name,
               voltage, avg_electric_current, frequency, active_power,
               power_factor, thd, tot_input_active_energy, active_power_demand
        FROM fnd_ecsu WHERE status = 'Y' OR status IS NULL
        ORDER BY display_seq, ecsu_id
    """))
    columns = result.keys()
    return [dict(zip(columns, row)) for row in result.fetchall()]


# ---------------------------------------------------------------------------
# Energy daily report
# ---------------------------------------------------------------------------

@router.get("/energy-daily")
async def energy_daily(
    date: Optional[str] = Query(None, description="YYYY-MM-DD"),
    db: AsyncSession = Depends(get_db),
    _=Depends(verify_bearer_token),
):
    date_filter = "AND creation_date_group::date = :date" if date else ""
    params = {"date": date} if date else {}

    result = await db.execute(text(f"""
        SELECT e.ecsu_id, e.ecsu_code_1 as building, e.ecsu_code_3 as room, e.ecsu_name,
               COALESCE(SUM(d.peak_energy_diff), 0) as peak_energy,
               COALESCE(SUM(d.mid_peak_energy_diff), 0) as mid_peak_energy,
               COALESCE(SUM(d.off_peak_energy_diff), 0) as off_peak_energy,
               COALESCE(SUM(d.peak_energy_diff + d.mid_peak_energy_diff + d.off_peak_energy_diff), 0) as total_energy,
               COALESCE(SUM(d.energy_charge), 0) as energy_charge
        FROM trx_periodical_energy_daily d
        JOIN fnd_ecsu e ON d.ecsu_id = e.ecsu_id
        WHERE 1=1 {date_filter}
        GROUP BY e.ecsu_id, e.ecsu_code_1, e.ecsu_code_3, e.ecsu_name
        ORDER BY e.ecsu_id
    """), params)
    columns = result.keys()
    return [dict(zip(columns, row)) for row in result.fetchall()]


# ---------------------------------------------------------------------------
# Energy monthly report
# ---------------------------------------------------------------------------

@router.get("/energy-monthly")
async def energy_monthly(
    month: Optional[str] = Query(None, description="YYYY-MM"),
    db: AsyncSession = Depends(get_db),
    _=Depends(verify_bearer_token),
):
    date_filter = "AND to_char(creation_date_group, 'YYYY-MM') = :month" if month else ""
    params = {"month": month} if month else {}

    result = await db.execute(text(f"""
        SELECT e.ecsu_id, e.ecsu_code_1 as building, e.ecsu_code_3 as room, e.ecsu_name,
               COALESCE(SUM(m.peak_energy_diff), 0) as peak_energy,
               COALESCE(SUM(m.mid_peak_energy_diff), 0) as mid_peak_energy,
               COALESCE(SUM(m.off_peak_energy_diff), 0) as off_peak_energy,
               COALESCE(SUM(m.peak_energy_diff + m.mid_peak_energy_diff + m.off_peak_energy_diff), 0) as total_energy,
               COALESCE(SUM(m.energy_charge), 0) as energy_charge
        FROM trx_periodical_energy_monthly m
        JOIN fnd_ecsu e ON m.ecsu_id = e.ecsu_id
        WHERE 1=1 {date_filter}
        GROUP BY e.ecsu_id, e.ecsu_code_1, e.ecsu_code_3, e.ecsu_name
        ORDER BY e.ecsu_id
    """), params)
    columns = result.keys()
    return [dict(zip(columns, row)) for row in result.fetchall()]


# ---------------------------------------------------------------------------
# Trend analysis
# ---------------------------------------------------------------------------

@router.get("/trend")
async def trend_analysis(
    start_date: Optional[str] = Query(None),
    end_date: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    _=Depends(verify_bearer_token),
):
    where = []
    params = {}
    if start_date:
        where.append("creation_date_group >= :start")
        params["start"] = start_date
    if end_date:
        where.append("creation_date_group <= :end")
        params["end"] = end_date

    where_sql = " AND ".join(where) if where else "1=1"

    result = await db.execute(text(f"""
        SELECT creation_date_group::date as date,
               COALESCE(SUM(peak_energy_diff), 0) as peak,
               COALESCE(SUM(mid_peak_energy_diff), 0) as mid_peak,
               COALESCE(SUM(off_peak_energy_diff), 0) as off_peak
        FROM trx_periodical_energy_daily
        WHERE {where_sql}
        GROUP BY creation_date_group::date
        ORDER BY date
    """), params)
    columns = result.keys()
    return [dict(zip(columns, row)) for row in result.fetchall()]


# ---------------------------------------------------------------------------
# Energy analysis (by ECSU)
# ---------------------------------------------------------------------------

@router.get("/energy-by-ecsu")
async def energy_by_ecsu(
    month: Optional[str] = Query(None, description="YYYY-MM"),
    db: AsyncSession = Depends(get_db),
    _=Depends(verify_bearer_token),
):
    date_filter = "AND to_char(m.creation_date_group, 'YYYY-MM') = :month" if month else ""
    params = {"month": month} if month else {}

    result = await db.execute(text(f"""
        SELECT e.ecsu_name,
               COALESCE(SUM(m.peak_energy_diff + m.mid_peak_energy_diff + m.off_peak_energy_diff), 0) as total_kwh,
               COALESCE(SUM(m.energy_charge), 0) as total_charge
        FROM trx_periodical_energy_monthly m
        JOIN fnd_ecsu e ON m.ecsu_id = e.ecsu_id
        WHERE 1=1 {date_filter}
        GROUP BY e.ecsu_name
        ORDER BY total_kwh DESC
    """), params)
    columns = result.keys()
    return [dict(zip(columns, row)) for row in result.fetchall()]


# ---------------------------------------------------------------------------
# Alerts
# ---------------------------------------------------------------------------

@router.get("/alerts")
async def alerts(
    start_date: Optional[str] = Query(None),
    end_date: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    _=Depends(verify_bearer_token),
):
    where = []
    params = {}
    if start_date:
        where.append("a.creation_date >= :start")
        params["start"] = start_date
    if end_date:
        where.append("a.creation_date <= :end")
        params["end"] = end_date
    where_sql = " AND ".join(where) if where else "1=1"

    result = await db.execute(text(f"""
        SELECT a.comm_abn_record_id, a.abn_type, a.abn_message, a.abn_date, a.creation_date,
               d.modbus_device_name as device_name
        FROM trx_comm_abn_record a
        LEFT JOIN fnd_modbus_device d ON a.modbus_device_id = d.modbus_device_id
        WHERE {where_sql}
        ORDER BY a.creation_date DESC
        LIMIT 100
    """), params)
    columns = result.keys()
    return [dict(zip(columns, row)) for row in result.fetchall()]


# ---------------------------------------------------------------------------
# Operation history
# ---------------------------------------------------------------------------

@router.get("/operation-history")
async def operation_history(
    start_date: Optional[str] = Query(None),
    end_date: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    _=Depends(verify_bearer_token),
):
    where = []
    params = {}
    if start_date:
        where.append("creation_date >= :start")
        params["start"] = start_date
    if end_date:
        where.append("creation_date <= :end")
        params["end"] = end_date
    where_sql = " AND ".join(where) if where else "1=1"

    result = await db.execute(text(f"""
        SELECT operation_history_id, operation_type, operation_desc, operator, creation_date
        FROM trx_operation_history
        WHERE {where_sql}
        ORDER BY creation_date DESC
        LIMIT 100
    """), params)
    columns = result.keys()
    return [dict(zip(columns, row)) for row in result.fetchall()]


# ---------------------------------------------------------------------------
# 811C Thermal Summary — latest per (edge, device)
# ---------------------------------------------------------------------------

@router.get("/thermal-latest")
async def thermal_latest(
    db: AsyncSession = Depends(get_db),
    _=Depends(verify_bearer_token),
):
    """Latest 5-minute thermal summary per (edge_id, device_id).

    目前 Edge 端整台 rpi 一筆（device_id='_all'），未來如果拆 per-camera
    這支 endpoint 會自動回傳每台一筆。
    """
    result = await db.execute(text("""
        SELECT DISTINCT ON (edge_id, device_id)
               edge_id, device_id, ts_start, ts_end,
               max_temp, min_temp, avg_temp,
               max_coord_row, max_coord_col, sample_count
        FROM trx_thermal_summary
        ORDER BY edge_id, device_id, ts_start DESC
    """))
    columns = result.keys()
    return [dict(zip(columns, row)) for row in result.fetchall()]


# ---------------------------------------------------------------------------
# 811C Thermal Summary — historical trend
# ---------------------------------------------------------------------------

@router.get("/thermal-trend")
async def thermal_trend(
    edge_id: Optional[str] = Query(None),
    device_id: Optional[str] = Query(None),
    start_date: Optional[str] = Query(None, description="ISO datetime or YYYY-MM-DD"),
    end_date: Optional[str] = Query(None, description="ISO datetime or YYYY-MM-DD"),
    db: AsyncSession = Depends(get_db),
    _=Depends(verify_bearer_token),
):
    """Historical thermal summary (for trend charts)."""
    where = []
    params = {}
    if edge_id:
        where.append("edge_id = :edge_id")
        params["edge_id"] = edge_id
    if device_id:
        where.append("device_id = :device_id")
        params["device_id"] = device_id
    if start_date:
        where.append("ts_start >= :start_date")
        params["start_date"] = _parse_iso_ts(start_date)
    if end_date:
        where.append("ts_start <= :end_date")
        params["end_date"] = _parse_iso_ts(end_date)
    where_sql = " AND ".join(where) if where else "1=1"

    result = await db.execute(text(f"""
        SELECT ts_start, ts_end, edge_id, device_id,
               max_temp, min_temp, avg_temp,
               max_coord_row, max_coord_col, sample_count
        FROM trx_thermal_summary
        WHERE {where_sql}
        ORDER BY ts_start ASC
        LIMIT 5000
    """), params)
    columns = result.keys()
    return [dict(zip(columns, row)) for row in result.fetchall()]


# ---------------------------------------------------------------------------
# Communication success rate
# ---------------------------------------------------------------------------

@router.get("/comm-rate")
async def comm_rate(
    date: Optional[str] = Query(None, description="YYYY-MM-DD"),
    db: AsyncSession = Depends(get_db),
    _=Depends(verify_bearer_token),
):
    date_filter = "AND c.rate_date::date = :date" if date else ""
    params = {"date": date} if date else {}

    result = await db.execute(text(f"""
        SELECT c.circuit_cs_rate_daily_id, c.rate_date,
               c.total_polls, c.success_polls, c.success_rate,
               d.modbus_device_name as device_name
        FROM trx_comm_success_rate_daily c
        LEFT JOIN fnd_modbus_device_circuit dc ON c.modbus_device_circuit_id = dc.modbus_device_circuit_id
        LEFT JOIN fnd_modbus_device d ON dc.modbus_device_id = d.modbus_device_id
        WHERE 1=1 {date_filter}
        ORDER BY c.rate_date DESC
        LIMIT 100
    """), params)
    columns = result.keys()
    return [dict(zip(columns, row)) for row in result.fetchall()]
