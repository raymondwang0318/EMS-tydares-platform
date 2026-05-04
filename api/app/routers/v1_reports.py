"""V2-final Reports router (ADR-026).

合併舊 10+ report endpoints 為 3 個統一 endpoint：
    GET /v1/reports/energy?granularity=5min|15min|1hr|1day&parameter_codes=...&from_ts=&to_ts=
    GET /v1/reports/thermal?mode=latest|trend&device_id=&from_ts=&to_ts=
    GET /v1/reports/events?kind=&severity=&from_ts=&to_ts=&limit=&offset=

T-Reports-001 backend 擴（M-PM-094 §三 改派 P12_sessionA）：
- granularity 加 5min（trx_reading time_bucket）+ 1hr；舊 daily/monthly 視為 alias
- parameter_codes: List[str]（多 metric 一次 call；舊 parameter_code 保留 deprecated alias）
- circuit_id 可選 filter（AEM-DRB1 per-circuit；prefix LIKE）
"""

from __future__ import annotations

from datetime import datetime

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


# T-Reports-001 backend 擴：granularity 路由策略
# - 5min / 1hr：query trx_reading + time_bucket（無 cagg view；性能可控：1hr ~3000 rows）
# - 15min / 1day / 1month：cagg view 直查（既有）
# alias: daily→1day, monthly→1month
_GRANULARITY_ALIAS = {"daily": "1day", "monthly": "1month"}
_BUCKET_INTERVAL = {
    "5min": "5 minutes",
    "1hr": "1 hour",
}
_CAGG_VIEW = {
    "15min": ("cagg_reading_15min", "bucket_15m"),
    "1day": ("cagg_reading_daily", "bucket_day"),
    "1month": ("cagg_reading_monthly", "bucket_month"),
}
_VALID_GRANULARITY = ("5min", "15min", "1hr", "1day", "1month", "daily", "monthly")


@router.get("/energy", response_model=EnergyReportResponse)
async def energy_report(
    granularity: str = Query("1day", description="5min|15min|1hr|1day|1month (daily/monthly alias)"),
    group_by: str = Query("device", pattern="^(device|ecsu)$"),
    from_ts: datetime = Query(...),
    to_ts: datetime = Query(...),
    parameter_codes: list[str] | None = Query(None, description="多 metric 一次 call (T-Reports-001)"),
    parameter_code: str | None = Query(None, description="DEPRECATED: 舊單一 metric；保留向下相容"),
    device_ids: list[str] | None = Query(None, description="filter device_id list"),
    circuit_id: str | None = Query(None, description="AEM-DRB1 per-circuit filter (e.g. ba1, bb12)"),
    db: AsyncSession = Depends(get_db),
):
    """能源報表（T-Reports-001 backend 擴）.

    granularity:
      - 5min / 1hr: trx_reading + time_bucket（無 cagg；高靈活度）
      - 15min / 1day(daily) / 1month(monthly): continuous aggregate view 直查
    parameter_codes: List[str] 多 metric 一次回；舊 parameter_code: str 保留 deprecated alias
    circuit_id: AEM-DRB1 per-circuit filter；用 parameter_code LIKE '{circuit_id}_%'
    """
    # === Validation ===
    if granularity not in _VALID_GRANULARITY:
        raise HTTPException(
            status_code=422,
            detail=f"granularity must be one of: {', '.join(_VALID_GRANULARITY)}",
        )
    granularity = _GRANULARITY_ALIAS.get(granularity, granularity)  # alias 轉正規

    if from_ts >= to_ts:
        raise HTTPException(status_code=422, detail="from_ts must be < to_ts")

    # parameter_codes 優先；舊 parameter_code 為 fallback alias（deprecated）
    params_list: list[str]
    if parameter_codes:
        params_list = parameter_codes
    elif parameter_code:
        params_list = [parameter_code]
    else:
        # 預設保留既有行為（避免空回不知道用戶意圖）
        params_list = ["tot_input_active_energy"]

    if not params_list:
        raise HTTPException(status_code=422, detail="parameter_codes must not be empty")

    # === 路由：cagg view vs trx_reading time_bucket ===
    if granularity in _BUCKET_INTERVAL:
        # 5min / 1hr: trx_reading + time_bucket
        rows = await _query_trx_time_bucket(
            db, _BUCKET_INTERVAL[granularity], group_by,
            from_ts, to_ts, params_list, device_ids, circuit_id,
        )
    else:
        # 15min / 1day / 1month: cagg view
        view, bucket_col = _CAGG_VIEW[granularity]
        rows = await _query_cagg_view(
            db, view, bucket_col, group_by,
            from_ts, to_ts, params_list, device_ids, circuit_id,
        )

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
        from_ts=from_ts.isoformat(), to_ts=to_ts.isoformat(), points=points,
    )


async def _query_trx_time_bucket(
    db: AsyncSession,
    interval: str,
    group_by: str,
    from_ts: datetime,
    to_ts: datetime,
    parameter_codes: list[str],
    device_ids: list[str] | None,
    circuit_id: str | None,
):
    """5min / 1hr: trx_reading + time_bucket aggregation.

    NB: trx_reading 無 first/last 直接欄；用 first_value() / last_value() window 太貴 →
    本路徑只回 avg/min/max；first/last/energy_delta 為 None（5min/1hr granularity 通常不需累積能量差）。

    NB2: time_bucket 的 interval 參數**內部受控**（來自 _BUCKET_INTERVAL dict，非用戶輸入），
    asyncpg cast str→interval 會撞 type mismatch（同 T-P12-002 踩坑）→ 直接 f-string inline 安全。
    """
    # interval 受控白名單守（雙保險防注入）
    if interval not in {"5 minutes", "1 hour"}:
        raise HTTPException(status_code=500, detail=f"unsupported bucket interval: {interval}")

    where_clauses = ["ts >= :from_ts", "ts < :to_ts"]
    params: dict = {
        "from_ts": from_ts, "to_ts": to_ts,
        "param_codes": parameter_codes,
    }
    where_clauses.append("parameter_code = ANY(:param_codes)")
    if device_ids:
        where_clauses.append("device_id = ANY(:device_ids)")
        params["device_ids"] = device_ids
    if circuit_id:
        where_clauses.append("parameter_code LIKE :circuit_prefix")
        params["circuit_prefix"] = f"{circuit_id}_%"

    where_sql = " AND ".join(where_clauses)

    if group_by == "device":
        sql = f"""
            SELECT time_bucket(INTERVAL '{interval}', ts) AS bucket,
                   device_id AS group_key,
                   parameter_code,
                   AVG(value) AS avg_value,
                   MIN(value) AS min_value,
                   MAX(value) AS max_value,
                   NULL::double precision AS first_value,
                   NULL::double precision AS last_value,
                   NULL::double precision AS energy_delta
            FROM trx_reading
            WHERE {where_sql}
            GROUP BY bucket, device_id, parameter_code
            ORDER BY bucket
        """
    else:
        # ecsu 分組於 5min/1hr 路徑暫不實作（trx_reading 無 circuit_code 對應 fnd_ecsu_circuit_assgn 結構複雜）
        # 升報觸發：若客戶要 5min ecsu group → 需 schema 改動，升報 PM
        raise HTTPException(
            status_code=422,
            detail="group_by=ecsu not supported for granularity 5min/1hr (use 15min+ for cagg path)",
        )

    return (await db.execute(text(sql), params)).fetchall()


async def _query_cagg_view(
    db: AsyncSession,
    view: str,
    bucket_col: str,
    group_by: str,
    from_ts: datetime,
    to_ts: datetime,
    parameter_codes: list[str],
    device_ids: list[str] | None,
    circuit_id: str | None,
):
    """15min / 1day / 1month: cagg view 直查."""
    params: dict = {
        "from_ts": from_ts, "to_ts": to_ts,
        "param_codes": parameter_codes,
    }

    if group_by == "device":
        where_clauses = [
            f"{bucket_col} >= :from_ts",
            f"{bucket_col} < :to_ts",
            "parameter_code = ANY(:param_codes)",
        ]
        if device_ids:
            where_clauses.append("device_id = ANY(:device_ids)")
            params["device_ids"] = device_ids
        if circuit_id:
            where_clauses.append("parameter_code LIKE :circuit_prefix")
            params["circuit_prefix"] = f"{circuit_id}_%"
        where_sql = " AND ".join(where_clauses)

        sql = f"""
            SELECT {bucket_col} AS ts, device_id AS group_key,
                   parameter_code, avg_value, min_value, max_value,
                   first_value, last_value,
                   (last_value - first_value) AS energy_delta
            FROM {view}
            WHERE {where_sql}
            ORDER BY {bucket_col}
        """
    else:
        # ecsu 分組（既有路徑保留）
        where_clauses = [
            f"r.{bucket_col} >= :from_ts",
            f"r.{bucket_col} < :to_ts",
            "r.parameter_code = ANY(:param_codes)",
        ]
        if device_ids:
            where_clauses.append("r.device_id = ANY(:device_ids)")
            params["device_ids"] = device_ids
        if circuit_id:
            where_clauses.append("r.parameter_code LIKE :circuit_prefix")
            params["circuit_prefix"] = f"{circuit_id}_%"
        where_sql = " AND ".join(where_clauses)

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
            WHERE {where_sql}
            GROUP BY r.{bucket_col}, e.ecsu_code, r.parameter_code
            ORDER BY r.{bucket_col}
        """

    return (await db.execute(text(sql), params)).fetchall()


_THERMAL_VALID_GRANULARITY = ("5min", "15min", "1hr", "1day")
_THERMAL_BUCKET_INTERVAL = {"5min": "5 minutes", "15min": "15 minutes", "1hr": "1 hour"}
_THERMAL_DEFAULT_PARAMS = ["max_temp", "min_temp", "avg_temp"]


@router.get("/thermal", response_model=ThermalReportResponse)
async def thermal_report(
    mode: str = Query("latest", pattern="^(latest|trend|history)$"),
    device_id: str | None = None,
    device_ids: list[str] | None = Query(None, description="history mode: filter device_id list"),
    parameter_codes: list[str] | None = Query(None, description="history mode: 預設 [max/min/avg_temp]"),
    granularity: str | None = Query(None, description="history mode: 5min|15min|1hr|1day"),
    from_ts: datetime | None = None,
    to_ts: datetime | None = None,
    db: AsyncSession = Depends(get_db),
):
    """Thermal 報表（T-Reports-001 §AC 2.4 backend；M-PM-100 §二補派）.

    mode:
      - latest: 既有；每 device_id × parameter_code 最新一筆
      - trend: 既有；cagg_thermal_daily ORDER BY bucket_day
      - history: 新增；granularity 5min/15min/1hr 走 trx_reading + time_bucket；
                 1day 走 cagg_thermal_daily。鏡像 [[M-P12-025]] energy pattern。
                 device_id LIKE '811c_%' 強制守門（純 IR 設備路徑）。
    """
    if mode == "history":
        return await _thermal_history(
            db, granularity, device_ids, parameter_codes, from_ts, to_ts,
        )

    if mode == "latest":
        where = ["parameter_code IN ('max_temp','min_temp','avg_temp')"]
        params: dict[str, object] = {}
        if device_id:
            where.append("device_id = :dev")
            params["dev"] = device_id
        sql = f"""
            SELECT DISTINCT ON (device_id, parameter_code)
                   device_id, parameter_code, value, ts
            FROM trx_reading
            WHERE {' AND '.join(where)}
            ORDER BY device_id, parameter_code, ts DESC
        """
        rows = (await db.execute(text(sql), params)).fetchall()
        items = [
            {
                "device_id": r[0],
                "parameter_code": r[1],
                "value": float(r[2]) if r[2] is not None else None,
                "ts": r[3].isoformat() if r[3] else None,
            }
            for r in rows
        ]
    else:
        if not from_ts or not to_ts:
            raise HTTPException(status_code=400, detail="trend mode requires from_ts and to_ts")
        where = ["bucket_day >= :from_ts", "bucket_day < :to_ts"]
        params = {"from_ts": from_ts, "to_ts": to_ts}
        if device_id:
            where.append("device_id = :dev")
            params["dev"] = device_id
        sql = f"""
            SELECT bucket_day, device_id, parameter_code, daily_max, daily_min, daily_avg
            FROM cagg_thermal_daily
            WHERE {' AND '.join(where)}
            ORDER BY bucket_day
        """
        rows = (await db.execute(text(sql), params)).fetchall()
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


async def _thermal_history(
    db: AsyncSession,
    granularity: str | None,
    device_ids: list[str] | None,
    parameter_codes: list[str] | None,
    from_ts: datetime | None,
    to_ts: datetime | None,
) -> ThermalReportResponse:
    """mode=history: 鏡像 [[M-P12-025]] energy pattern.

    granularity:
      - 5min/15min/1hr: trx_reading + time_bucket（device_id LIKE '811c_%' 守門）
      - 1day: cagg_thermal_daily 既有
    parameter_codes 預設 [max_temp, min_temp, avg_temp]（thermal 三 metric 全套）
    device_ids 可選 filter
    """
    # Validation
    if granularity is None or granularity not in _THERMAL_VALID_GRANULARITY:
        raise HTTPException(
            status_code=422,
            detail=f"history mode requires granularity ∈ {{{', '.join(_THERMAL_VALID_GRANULARITY)}}}",
        )
    if from_ts is None or to_ts is None:
        raise HTTPException(status_code=422, detail="history mode requires from_ts and to_ts")
    if from_ts >= to_ts:
        raise HTTPException(status_code=422, detail="from_ts must be < to_ts")

    params_list = parameter_codes if parameter_codes else _THERMAL_DEFAULT_PARAMS

    # M-PM-102 Bug 7: max_coord_* 用 last_value (B 設計取捨)；溫度仍 MAX/MIN/AVG
    # 拆 params_list 為 temp_codes (max/min/avg_temp) + coord_codes (max_coord_*)
    temp_codes = [p for p in params_list if not p.startswith("max_coord_")]
    coord_codes = [p for p in params_list if p.startswith("max_coord_")]

    if granularity == "1day":
        # M-PM-102 §2.3 設計取捨（DLC 候選）:
        # - temp_codes 走 cagg_thermal_daily 既有 daily_max/min/avg
        # - coord_codes 不走 cagg（daily_max 對 0-7 離散座標語意錯）;
        #   改 trx_reading + time_bucket('1 day', ts) 取 last_value
        # 兩段 UNION ALL，前端統一接 max/min/avg_value (coord 三欄同值=last)
        rows = []
        params: dict = {"from_ts": from_ts, "to_ts": to_ts}

        if temp_codes:
            params_temp = {**params, "temp_codes": temp_codes}
            where_t = ["bucket_day >= :from_ts", "bucket_day < :to_ts",
                       "parameter_code = ANY(:temp_codes)",
                       "device_id LIKE '811c\\_%' ESCAPE '\\'"]
            if device_ids:
                where_t.append("device_id = ANY(:device_ids)")
                params_temp["device_ids"] = device_ids
            sql_t = f"""
                SELECT bucket_day AS ts, device_id, parameter_code,
                       daily_max AS max_value, daily_min AS min_value, daily_avg AS avg_value
                FROM cagg_thermal_daily
                WHERE {' AND '.join(where_t)}
            """
            rows.extend((await db.execute(text(sql_t), params_temp)).fetchall())

        if coord_codes:
            params_c = {**params, "coord_codes": coord_codes}
            where_c = ["ts >= :from_ts", "ts < :to_ts",
                       "parameter_code = ANY(:coord_codes)",
                       "device_id LIKE '811c\\_%' ESCAPE '\\'"]
            if device_ids:
                where_c.append("device_id = ANY(:device_ids)")
                params_c["device_ids"] = device_ids
            sql_c = f"""
                SELECT time_bucket(INTERVAL '1 day', ts) AS ts,
                       device_id, parameter_code,
                       (array_agg(value ORDER BY ts DESC))[1] AS max_value,
                       (array_agg(value ORDER BY ts DESC))[1] AS min_value,
                       (array_agg(value ORDER BY ts DESC))[1] AS avg_value
                FROM trx_reading
                WHERE {' AND '.join(where_c)}
                GROUP BY ts, device_id, parameter_code
            """
            rows.extend((await db.execute(text(sql_c), params_c)).fetchall())

        # Sort merged result
        rows = sorted(rows, key=lambda r: (r[0], r[1], r[2]))
    else:
        # 5min / 15min / 1hr: trx_reading + time_bucket
        # interval 受控（同 energy 5min/1hr fix；防 asyncpg cast 踩坑）
        interval = _THERMAL_BUCKET_INTERVAL[granularity]
        if interval not in {"5 minutes", "15 minutes", "1 hour"}:
            raise HTTPException(status_code=500, detail=f"unsupported bucket interval: {interval}")

        where_clauses = ["ts >= :from_ts", "ts < :to_ts",
                         "parameter_code = ANY(:param_codes)",
                         "device_id LIKE '811c\\_%' ESCAPE '\\'"]
        params = {"from_ts": from_ts, "to_ts": to_ts, "param_codes": params_list}
        if device_ids:
            where_clauses.append("device_id = ANY(:device_ids)")
            params["device_ids"] = device_ids

        # M-PM-102 §2.2 (B): max_coord_* 用 last_value (array_agg ORDER BY ts DESC)[1]
        # 同一筆 sample 的 row 與 col 對齊（避免 MAX(row) 配 MAX(col) 來自不同採樣）
        sql = f"""
            SELECT time_bucket(INTERVAL '{interval}', ts) AS bucket,
                   device_id, parameter_code,
                   CASE WHEN parameter_code LIKE 'max_coord_%'
                        THEN (array_agg(value ORDER BY ts DESC))[1]
                        ELSE MAX(value)
                   END AS max_value,
                   CASE WHEN parameter_code LIKE 'max_coord_%'
                        THEN (array_agg(value ORDER BY ts DESC))[1]
                        ELSE MIN(value)
                   END AS min_value,
                   CASE WHEN parameter_code LIKE 'max_coord_%'
                        THEN (array_agg(value ORDER BY ts DESC))[1]
                        ELSE AVG(value)
                   END AS avg_value
            FROM trx_reading
            WHERE {' AND '.join(where_clauses)}
            GROUP BY bucket, device_id, parameter_code
            ORDER BY bucket, device_id, parameter_code
        """
        rows = (await db.execute(text(sql), params)).fetchall()

    items = [
        {
            "ts": r[0].isoformat() if r[0] else None,
            "device_id": r[1],
            "parameter_code": r[2],
            "max_value": float(r[3]) if r[3] is not None else None,
            "min_value": float(r[4]) if r[4] is not None else None,
            "avg_value": float(r[5]) if r[5] is not None else None,
        }
        for r in rows
    ]
    return ThermalReportResponse(mode="history", items=items)


@router.get("/events", response_model=EventsReportResponse)
async def events_report(
    kind: str | None = None,
    severity: str | None = None,
    edge_id: str | None = None,
    device_id: str | None = None,
    from_ts: datetime | None = None,
    to_ts: datetime | None = None,
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
