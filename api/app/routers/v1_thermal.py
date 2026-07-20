"""V1 Thermal public meta router — M-PM-341 議題C 熱力圖 Open View enabler.

訪客（未登入）熱力圖 read-only：只回前端 ThermalView 組 SSE URL +
TC↔位置對應所需的最小欄位，刻意不暴露 edges 管理/敏感欄位
（fingerprint / previous_fingerprints / status / config_version / approved_at / cpu_temp）。

對齊 M-P11-E91 交球：admin-ui ThermalView（iframe 嵌 Pananora 熱力圖頁）需
  - edge last_seen_ip（組 {ip}:8080/stream/811c SSE 直連 Edge）
  - 811C IR device device_id / display_name(位置) / edge_id
SSE 串流本體已 public（Edge /stream/811c，CORS *，M-PM-158）；本 endpoint 補齊 meta 後訪客即完整看熱力圖。

安全：本 router public（不掛 verify_admin_token），但僅回熱像必要最小集；
所有寫操作（approve/revoke/label upsert）維持 admin only（v1_admin 整 router 掛 verify_admin_token）。
原 GET /v1/admin/edges 回 fingerprint 等憑證欄位，故不直接放寬該 endpoint，改走本最小集 endpoint。
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_db
from app.models import EmsEdge

router = APIRouter(prefix="/v1/thermal", tags=["thermal"])


@router.get("/meta")
async def thermal_meta(db: AsyncSession = Depends(get_db)):
    """熱力圖訪客 read-only meta：edges last_seen_ip + 811C IR device 位置對應.

    M-PM-341 議題C Open View enabler（訪客未登入可讀）。
    刻意只回最小欄位：
      - edges：edge_id + last_seen_ip（組 SSE URL 用；不含 fingerprint/status/config_version）
      - ir_devices：device_id + display_name + edge_id + last_seen（不含 ip_address）
    """
    # ir_devices：對齊 /admin/ir-devices 的 soft-archive filter（拆除設備不顯示），
    # 但只回熱像顯示最小欄位（去 ip_address；SSE 用 edge IP 非 TC IP）。
    # 🔴 時間窗鐵則（同 v1_admin_fleet binding-scan 教訓）：trx_reading 是數千萬行 hypertable，
    # WHERE device_id LIKE '811c_%' 無時間窗會全 chunk 掃描 → 雙 channel 補傳歷史灌爆後 hang(>12s)。
    # 加近 6h 窗（811C 每 5min 上報，6h 必涵蓋在線 device）→ hypertable 只掃近 6h chunk。
    ir_rows = await db.execute(text("""
        SELECT
          t.device_id,
          m.display_name,
          m.edge_id,
          MAX(t.ts) AS last_seen
        FROM trx_reading t
        LEFT JOIN ems_ir_device_metadata m ON m.device_id = t.device_id
        WHERE t.device_id LIKE '811c_%'
          AND t.ts > NOW() - INTERVAL '6 hours'
        GROUP BY t.device_id, m.display_name, m.edge_id, m.archived_at
        HAVING m.archived_at IS NULL OR MAX(t.ts) > m.archived_at
        ORDER BY t.device_id
    """))
    ir_devices = [
        {
            "device_id": row[0],
            "display_name": row[1],
            "edge_id": row[2],
            "last_seen": row[3].isoformat() if row[3] else None,
        }
        for row in ir_rows.fetchall()
    ]

    # 🔴 M-P11-E92 親驗修正：edges 只回「有 811C IR device」的 edge。
    # 原回全 fleet 22 台 → ThermalView 對無 811C 的 edge（如 E23=.71）也連 /stream/811c
    # → ERR_CONNECTION_REFUSED 洗版 console + EventSource 狂重連。只保留 ir_devices 涉及的 edge。
    ir_edge_ids = {r["edge_id"] for r in ir_devices if r["edge_id"]}

    # edges：只回「有 811C IR device」且有 last_seen_ip 的 edge（給 ThermalView 組 SSE URL）
    edge_rows = (await db.execute(
        select(EmsEdge).order_by(EmsEdge.edge_id)
    )).scalars().all()
    edges = [
        {"edge_id": e.edge_id, "last_seen_ip": e.last_seen_ip}
        for e in edge_rows
        if e.last_seen_ip and e.edge_id in ir_edge_ids
    ]

    return {"edges": edges, "ir_devices": ir_devices}
