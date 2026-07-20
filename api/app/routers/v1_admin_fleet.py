"""V2-final Fleet 健康儀表板 + ECSU 綁定全掃 API（M-PM-328 軌1 / M-P10C-053 項 B+C）.

唯讀維運查詢 endpoint；數據源對齊 02_Central/維運查詢_SSOT.md §1-3 / §5 / §7。
全掛 verify_admin_token（viewer 唯讀帳號亦可讀 — fleet 健康為唯讀資訊）。

endpoints（prefix /v1/admin）：
  GET /fleet/health              fleet 上線/缺席/電表上報（SSOT §1-3）
  GET /fleet/power-events        當前快照斷電群集偵測（SSOT §7；Phase 1 當前快照非歷史）
  GET /ecsu/binding-health-scan  ECSU 綁定雙維度全掃（SSOT §5）
"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_db, verify_admin_token

router = APIRouter(
    prefix="/v1/admin", tags=["admin-fleet"],
    dependencies=[Depends(verify_admin_token)],
)

# fleet edge 範圍：排除已全清的 E66（對齊維運查詢 SSOT §1）
_FLEET_FILTER = "edge_id LIKE 'TYDARES-E%' AND edge_id != 'TYDARES-E66'"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _cluster(rows: list, ts_key: str, window_sec: int = 60) -> list:
    """把已按 ts_key 排序的 rows 依時間戳 ±window_sec 群集（同時斷電歸一事件）。

    回 [{"anchor": ts, "min_ts": ts, "rows": [...]}]；anchor 法（rows 須已排序使相近者相鄰）。
    """
    clusters: list[dict] = []
    for r in rows:
        ts = r[ts_key]
        for c in clusters:
            if abs((ts - c["anchor"]).total_seconds()) <= window_sec:
                c["rows"].append(r)
                if ts < c["min_ts"]:
                    c["min_ts"] = ts
                break
        else:
            clusters.append({"anchor": ts, "min_ts": ts, "rows": [r]})
    return clusters


@router.get("/fleet/health")
async def fleet_health(db: AsyncSession = Depends(get_db)):
    """Fleet 上線總覽（SSOT §1-3）：在線/總數 + 缺席清單 + 電表上報 5min。"""
    overview = (await db.execute(text(f"""
        SELECT COUNT(*) FILTER (WHERE last_seen_at > NOW()-INTERVAL '5 minutes') AS online,
               COUNT(*) AS total
        FROM ems_edge WHERE {_FLEET_FILTER}
    """))).mappings().fetchone()

    absent = (await db.execute(text(f"""
        SELECT edge_id, last_seen_at,
               EXTRACT(EPOCH FROM (NOW()-last_seen_at))::int AS offline_sec
        FROM ems_edge
        WHERE {_FLEET_FILTER}
          AND (last_seen_at < NOW()-INTERVAL '5 minutes' OR last_seen_at IS NULL)
        ORDER BY edge_id
    """))).mappings().all()

    meters = (await db.execute(text("""
        SELECT COUNT(DISTINCT device_id) AS meters_5min
        FROM trx_reading WHERE ts > NOW()-INTERVAL '5 minutes'
    """))).scalar_one()

    return {
        "online": overview["online"],
        "total": overview["total"],
        "absent": [
            {"edge_id": r["edge_id"],
             "offline_sec": r["offline_sec"],
             "last_seen_at": r["last_seen_at"].isoformat() if r["last_seen_at"] else None}
            for r in absent
        ],
        "meters_reporting_5min": meters,
        "scanned_at": _now_iso(),
    }


@router.get("/fleet/power-events")
async def fleet_power_events(
    gap_threshold_sec: int = 300,
    db: AsyncSession = Depends(get_db),
):
    """斷電偵測（M-PM-333 Q1：Phase 1 當前快照 + Phase 2 heartbeat gap 歷史）。

    current_events：ems_edge.last_seen_at 當前快照，缺席 edge ±60s 窗群集 = 當前/最近斷電。
    historical_outages：ems_edge_heartbeat 14 天 hb_ts gap > 門檻 = 該 edge 斷線窗；
        gap_start ±60s 多 edge 群集 = 一次 fleet 斷電事件（零 schema 改動）。
    ⚠️ 以實際 schema 為準用 hb_ts（非 PM spec 的 last_seen_at，那是 ems_edge 欄位）；
       歷史深度 = heartbeat 保留期（~14 天）。
    """
    # Phase 1：當前快照群集（SSOT §7）
    snap = (await db.execute(text(f"""
        SELECT edge_id, last_seen_at
        FROM ems_edge
        WHERE {_FLEET_FILTER}
          AND last_seen_at IS NOT NULL
          AND last_seen_at < NOW()-INTERVAL '5 minutes'
        ORDER BY last_seen_at DESC
    """))).mappings().all()
    current_events = [
        {"cluster_time": c["min_ts"].isoformat(),
         "affected_count": len(c["rows"]),
         "edges": sorted(r["edge_id"] for r in c["rows"])}
        for c in _cluster(snap, "last_seen_at", 60)
    ]

    # Phase 2：heartbeat gap 歷史（hb_ts；gap_start NULL/gap_seconds NULL 由 WHERE 濾除）
    gaps = (await db.execute(text(f"""
        SELECT edge_id, gap_start, gap_end, gap_seconds
        FROM (
          SELECT edge_id, hb_ts AS gap_end,
                 LAG(hb_ts) OVER (PARTITION BY edge_id ORDER BY hb_ts) AS gap_start,
                 EXTRACT(EPOCH FROM (hb_ts - LAG(hb_ts) OVER (PARTITION BY edge_id ORDER BY hb_ts)))::int AS gap_seconds
          FROM ems_edge_heartbeat
          WHERE hb_ts > NOW()-INTERVAL '14 days'
            AND {_FLEET_FILTER}
        ) g
        WHERE gap_seconds > :thr
        ORDER BY gap_start DESC
    """), {"thr": gap_threshold_sec})).mappings().all()
    historical_outages = [
        {"outage_start": c["min_ts"].isoformat(),
         "affected_count": len(c["rows"]),
         "edges": sorted(r["edge_id"] for r in c["rows"]),
         "max_gap_seconds": max(r["gap_seconds"] for r in c["rows"])}
        for c in _cluster(gaps, "gap_start", 60)
    ]

    return {
        "current_events": current_events,
        "historical_outages": historical_outages,
        "gap_threshold_sec": gap_threshold_sec,
        "history_days": 14,
        "note": "current=當前快照群集；historical=heartbeat gap（hb_ts，~14 天保留期內）",
        "scanned_at": _now_iso(),
    }


@router.get("/ecsu/binding-health-scan")
async def ecsu_binding_health_scan(db: AsyncSession = Depends(get_db)):
    """ECSU 綁定雙維度全掃（SSOT §5）。

    維度 A：綁定指向已刪 / 不存在 / 停用 device。
    維度 B：綁定健康但 trx_reading 斷流 > 1hr。
    唯讀，每次重跑（不 cache）。
    """
    dim_a = (await db.execute(text("""
        SELECT e.ecsu_code, e.ecsu_name, e.region, a.assgn_id, a.device_id,
          CASE WHEN d.device_id IS NULL THEN '❌device不存在'
               WHEN d.deleted_at IS NOT NULL THEN '❌已soft-delete('||to_char(d.deleted_at,'MM-DD')||')'
               WHEN NOT d.enabled THEN '⚠️disabled'
               ELSE 'ok' END AS device_status
        FROM fnd_ecsu_circuit_assgn a
        JOIN fnd_ecsu e ON e.ecsu_id = a.ecsu_id
        LEFT JOIN ems_device d ON d.device_id = a.device_id
        WHERE a.enabled AND e.enabled
          AND (d.device_id IS NULL OR d.deleted_at IS NOT NULL OR NOT d.enabled)
        ORDER BY e.ecsu_code
    """))).mappings().all()

    dim_b = (await db.execute(text("""
        SELECT e.ecsu_code, e.region, a.device_id,
          to_char(MAX(r.ts), 'MM-DD HH24:MI') AS last_seen,
          date_trunc('minute', NOW()-MAX(r.ts))::text AS lag
        FROM fnd_ecsu_circuit_assgn a
        JOIN fnd_ecsu e ON e.ecsu_id = a.ecsu_id
        JOIN ems_device d ON d.device_id = a.device_id AND d.deleted_at IS NULL AND d.enabled
        -- trx_reading 限近 3hr 窗（避免全表掃描 timeout；ts 索引近窗 ~1s）：
        -- 斷流>3hr→MAX NULL（HAVING IS NULL 抓）；斷流1-3hr→MAX<1hr ago。等價「斷流>1hr」語意
        LEFT JOIN trx_reading r ON r.device_id = a.device_id AND r.ts > NOW()-INTERVAL '3 hours'
        WHERE a.enabled AND e.enabled
        GROUP BY e.ecsu_code, e.region, a.device_id
        HAVING MAX(r.ts) IS NULL OR MAX(r.ts) < NOW()-INTERVAL '1 hour'
        ORDER BY MAX(r.ts) ASC NULLS FIRST
    """))).mappings().all()

    return {
        "dimension_a_invalid_bindings": [dict(r) for r in dim_a],
        "dimension_b_stale_data": [dict(r) for r in dim_b],
        "scanned_at": _now_iso(),
    }
