"""V2-final Circuits router (M-PM-249 §二 工作包 B endpoints #2-4).

業務查詢 circuit 層級能耗，供老闆 Pananora 整合（方案丙）使用。

底層全部複用既建（M-PM-237 mapping layer + cagg + trx_reading time_bucket）：
- realtime: trx_reading + map_circuit_to_power_param() → parameter_code
- daily:    cagg_reading_daily `last_value - first_value`；compare 一 query 兩天
- hourly:   cagg_reading_15min agg per hour 或 trx_reading time_bucket('1 hour')

對齊 v1_reports.py + v1_admin.ecsu_realtime/monthly 風格（M-P12-052 / M-PM-237 既建）.

URL prefix /v1/circuits/* — 對齊 PM 信 M-PM-249 §2.3 裁示
（業務查詢 prefix；配置列表 `/v1/admin/circuits` 在 v1_admin.py M-PM-249 §一 區段）.
"""

from __future__ import annotations

from datetime import date as _date, datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.constants.device_circuits import (
    get_circuits,
    map_circuit_to_energy_param,
    map_circuit_to_power_param,
)
from app.dependencies import get_db, verify_admin_token

router = APIRouter(
    prefix="/v1/circuits",
    tags=["circuits"],
    dependencies=[Depends(verify_admin_token)],
)


# ============================================================================
# Helper: 採證 device + circuit 合法性
# ============================================================================


async def _resolve_device_and_param(
    db: AsyncSession,
    device_id: str,
    circuit_code: str,
    mode: str,  # 'power' | 'energy'
) -> tuple[str, str, str]:
    """Verify device exists + circuit_code legal for device_kind; return (device_kind, edge_id, parameter_code).

    Raises HTTPException 404 / 422 accordingly.
    """
    row = (await db.execute(text("""
        SELECT device_id, device_kind, edge_id
        FROM ems_device
        WHERE device_id = :device_id AND deleted_at IS NULL
    """), {"device_id": device_id})).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail=f"device_id '{device_id}' not found")
    device_kind, edge_id = row[1], row[2]

    circuits = get_circuits(device_kind)
    if not circuits:
        raise HTTPException(status_code=422,
                            detail=f"device_kind '{device_kind}' has no circuit schema")
    cc_normalized = (circuit_code or "").lower()
    legal_codes = {c["code"].lower() for c in circuits}
    if cc_normalized not in legal_codes:
        raise HTTPException(status_code=422, detail={
            "error": "circuit_code_invalid",
            "device_kind": device_kind,
            "circuit_code": circuit_code,
            "legal_circuits": sorted(legal_codes),
        })

    if mode == "power":
        parameter_code = map_circuit_to_power_param(cc_normalized, device_id)
    elif mode == "energy":
        parameter_code = map_circuit_to_energy_param(cc_normalized, device_id)
    else:
        raise HTTPException(status_code=500, detail=f"internal: bad mode '{mode}'")

    return device_kind, edge_id, parameter_code


# ============================================================================
# #2: 即時功率 (kW)
# ============================================================================


@router.get("/{device_id}/{circuit_code}/realtime")
async def circuit_realtime(
    device_id: str = Path(...),
    circuit_code: str = Path(...),
    db: AsyncSession = Depends(get_db),
):
    """單一迴路即時功率（kW + ts）.

    M-PM-249 §二 #2；複用 M-PM-237 mapping layer（ecsu_realtime 內部邏輯抽出單 binding 不 sum）.

    aem_drb: 'ba1' → parameter_code='ba1_p'；'ba1-3' → 'ba1_3_p_sum'（三相聚合 driver 內建）
    cpm23/cpm12d: any → 'power_total'

    取最近 5 min 內 trx_reading latest value（與 ecsu_realtime() 一致）；
    value 單位是 driver 推到 W → 轉 kW（÷1000）.
    """
    device_kind, edge_id, parameter_code = await _resolve_device_and_param(
        db, device_id, circuit_code, mode="power"
    )

    row = (await db.execute(text("""
        SELECT value, ts FROM trx_reading
        WHERE device_id = :device_id
          AND parameter_code = :param_code
          AND ts > NOW() - INTERVAL '5 minutes'
        ORDER BY ts DESC LIMIT 1
    """), {"device_id": device_id, "param_code": parameter_code})).fetchone()

    value_w = float(row[0]) if row is not None and row[0] is not None else None
    value_kw = (value_w / 1000.0) if value_w is not None else None
    ts = row[1].isoformat() if row is not None and row[1] is not None else None

    return {
        "device_id": device_id,
        "device_kind": device_kind,
        "edge_id": edge_id,
        "circuit_code": circuit_code,
        "parameter_code": parameter_code,  # debug 用
        "realtime_kw": value_kw,
        "ts": ts,
        "window": "5min",
        "data_source": "trx_reading",
    }


# ============================================================================
# #3: 指定日用電 (kWh) + 對比
# ============================================================================


def _parse_date_or_400(s: str, field: str) -> _date:
    try:
        return datetime.strptime(s, "%Y-%m-%d").date()
    except (ValueError, TypeError):
        raise HTTPException(status_code=422, detail=f"{field} must be YYYY-MM-DD; got {s!r}")


@router.get("/{device_id}/{circuit_code}/daily")
async def circuit_daily(
    device_id: str = Path(...),
    circuit_code: str = Path(...),
    date: str = Query(..., description="YYYY-MM-DD"),
    compare: str = Query("none", pattern="^(none|last_week|last_day)$",
                         description="對比哪一天：none / last_week / last_day"),
    db: AsyncSession = Depends(get_db),
):
    """指定日用電 kWh + 對比日（last_week = 7 天前同日；last_day = 前一天）.

    底層：cagg_reading_daily `last_value - first_value`；一 query 兩天.

    aem_drb: 'ba1' → parameter_code='ba1_ae_imp'
    cpm23/cpm12d: → 'energy_kwh_imp'
    """
    device_kind, edge_id, parameter_code = await _resolve_device_and_param(
        db, device_id, circuit_code, mode="energy"
    )

    target_date = _parse_date_or_400(date, "date")

    compare_date = None
    if compare == "last_week":
        compare_date = target_date - timedelta(days=7)
    elif compare == "last_day":
        compare_date = target_date - timedelta(days=1)

    # cagg_reading_daily bucket_day 是 timestamptz；用 :: 對齊 date.
    sql = text("""
        SELECT bucket_day::date AS d,
               (last_value - first_value) AS kwh
        FROM cagg_reading_daily
        WHERE device_id = :device_id
          AND parameter_code = :param_code
          AND bucket_day::date = ANY(:dates)
    """)
    dates = [target_date]
    if compare_date is not None:
        dates.append(compare_date)
    rows = (await db.execute(sql, {
        "device_id": device_id,
        "param_code": parameter_code,
        "dates": dates,
    })).fetchall()

    by_date: dict[_date, float | None] = {r[0]: (float(r[1]) if r[1] is not None else None) for r in rows}
    today_kwh = by_date.get(target_date)
    compare_payload = None
    if compare != "none" and compare_date is not None:
        compare_kwh = by_date.get(compare_date)
        delta_pct = None
        if today_kwh is not None and compare_kwh is not None and compare_kwh != 0:
            delta_pct = round((today_kwh - compare_kwh) / compare_kwh * 100.0, 2)
        compare_payload = {
            "mode": compare,
            "date": compare_date.isoformat(),
            "kwh": compare_kwh,
            "delta_pct": delta_pct,
        }

    return {
        "device_id": device_id,
        "device_kind": device_kind,
        "edge_id": edge_id,
        "circuit_code": circuit_code,
        "parameter_code": parameter_code,
        "date": target_date.isoformat(),
        "kwh": today_kwh,
        "compare": compare_payload,
        "data_source": "cagg_reading_daily",
    }


# ============================================================================
# #4: 24h 每小時用電序列（sparkline）
# ============================================================================


def _parse_dt_or_400(s: str, field: str) -> datetime:
    """Accept ISO-8601 with or without timezone; default to UTC for offset-naive."""
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        raise HTTPException(status_code=422, detail=f"{field} must be ISO-8601 datetime; got {s!r}")
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


@router.get("/{device_id}/{circuit_code}/hourly")
async def circuit_hourly(
    device_id: str = Path(...),
    circuit_code: str = Path(...),
    from_ts: str = Query(..., description="ISO-8601 start"),
    to_ts: str = Query(..., description="ISO-8601 end"),
    db: AsyncSession = Depends(get_db),
):
    """每小時 kWh 序列（sparkline 用；典型用法：from_ts=now-24h, to_ts=now）.

    底層：trx_reading + time_bucket('1 hour')；每 bucket 取 (last - first) approx energy_delta.

    NB: 因 trx_reading 無 first_value() / last_value() 直接欄，用 MAX/MIN value 近似
    （能量計 ae_imp 單調遞增，MAX=last, MIN=first；對齊 ecsu_monthly 的同樣 trick）.

    與 v1_reports.energy_report 不同：本 endpoint 專為 sparkline 設計，固定回 energy_delta；
    不回 avg/min/max（reports/energy 5min/1hr 路徑沒回 first/last，這是 gap 報告 §4 #4 補的）.
    """
    device_kind, edge_id, parameter_code = await _resolve_device_and_param(
        db, device_id, circuit_code, mode="energy"
    )

    from_dt = _parse_dt_or_400(from_ts, "from_ts")
    to_dt = _parse_dt_or_400(to_ts, "to_ts")
    if from_dt >= to_dt:
        raise HTTPException(status_code=422, detail="from_ts must be < to_ts")
    if (to_dt - from_dt) > timedelta(days=7):
        raise HTTPException(status_code=422, detail="window too large; max 7 days (sparkline scope)")

    # NB: time_bucket interval inline；whitelist 受控（同 T-P12-002 踩坑）
    sql = text("""
        SELECT time_bucket(INTERVAL '1 hour', ts) AS bucket,
               MAX(value) - MIN(value) AS kwh_delta
        FROM trx_reading
        WHERE device_id = :device_id
          AND parameter_code = :param_code
          AND ts >= :from_ts
          AND ts < :to_ts
        GROUP BY bucket
        ORDER BY bucket
    """)
    rows = (await db.execute(sql, {
        "device_id": device_id,
        "param_code": parameter_code,
        "from_ts": from_dt,
        "to_ts": to_dt,
    })).fetchall()

    points = [
        {
            "ts": r[0].isoformat() if r[0] else None,
            "kwh": float(r[1]) if r[1] is not None else None,
        }
        for r in rows
    ]

    return {
        "device_id": device_id,
        "device_kind": device_kind,
        "edge_id": edge_id,
        "circuit_code": circuit_code,
        "parameter_code": parameter_code,
        "from_ts": from_dt.isoformat(),
        "to_ts": to_dt.isoformat(),
        "granularity": "1hour",
        "points": points,
        "data_source": "trx_reading (time_bucket 1h; MAX-MIN approx)",
    }
