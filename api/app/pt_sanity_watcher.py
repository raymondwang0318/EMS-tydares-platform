"""PT/CT 設定合理性看門狗（A6-②，老王 2026-07-21 拍板「兩件一起 GO」）.

電表 PT/CT/接線設定錯誤是「安靜的錯」：不跳錯、不斷線，但每筆量測都錯一個
固定比例（8.4% 案）。本 watcher 定期比對各表「實測電壓」與「額定申報」，
異常開 ems_events 事件單——觀察期 notify_pananora=FALSE 只記不發信
（mail_worker 撿單條件=notify_pananora=TRUE，結構性保證不誤發）。

三條規則（門檻以 2026-07-21 全 fleet 33 量測單元實值校準，現況零誤報）：
  R1 voltage_off_nominal：顯示電壓偏離最近標稱電壓 >15%
     → 疑 PT 檔位量級錯/接線錯（warning）。台電波動 ±10% 內不觸發。
  R2 hv_pt_secondary_nonstd：高壓表（pt_primary≥3000）pt_secondary≠110
     → 台灣高壓 PT 二次標準 110V，請核對 PT 銘牌（info；上線即抓 KW-01=120）。
  R3 rated_mismatch：直讀表（pt_primary==pt_secondary，無換算）額定申報與
     實測電壓差 >50% → 設定不符但不影響量測（info；上線即抓 5 顆 AEM 600 檔）。

能力邊界（對外說明必帶）：PT 二次 110/120 檔位差僅 8.3%，淹沒在電網正常
波動內，R1 抓不到——那類要靠月度台電帳單對帳；本 watcher 抓量級錯/接線錯。

評估單元：CPM 類=整表；AEM-DRB=ma/mb 兩主表各一單元（branch 繼承 main）。
電壓維度依 sys_wire 決定（L-L only 接線取線電壓，否則相電壓優先）——
對齊 constants/device_circuits.py WIRE_LL_ONLY_BY_KIND（M-PM-315）。
排除：電壓 <40V（停電/未接線）不評估；近 2h 無上報（失聯）自然不進查詢。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os

from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.constants.device_circuits import WIRE_LL_ONLY_BY_KIND

log = logging.getLogger("pt_sanity_watcher")

TICK_SEC = float(os.getenv("PT_SANITY_TICK_SEC", "1800"))  # 30 分鐘（設定錯誤是常駐狀態不急）
NOMINALS = [110.0, 220.0, 380.0, 440.0, 11400.0, 22800.0]  # 台灣配電標稱電壓集合
R1_DEV_PCT = float(os.getenv("PT_SANITY_R1_PCT", "15"))    # 偏離標稱門檻 %
R3_DEV_PCT = float(os.getenv("PT_SANITY_R3_PCT", "50"))    # 額定 vs 實測門檻 %
MIN_VOLTAGE = 40.0                                          # 低於此視為停電/未接，不評估

PARAMS = [
    "sys_wire", "pt_primary", "pt_secondary", "voltage_ll_avg", "voltage_ln_avg",
    "ma_sys_wire", "ma_pt_primary", "ma_pt_secondary", "ma_v_avg", "ma_u_avg",
    "mb_sys_wire", "mb_pt_primary", "mb_pt_secondary", "mb_v_avg", "mb_u_avg",
]

_LATEST_SQL = """
SELECT DISTINCT ON (device_id, parameter_code) device_id, parameter_code, value
FROM trx_reading
WHERE ts > now() - interval '2 hours' AND parameter_code = ANY(:params)
ORDER BY device_id, parameter_code, ts DESC
"""


def _kind_of(device_id: str) -> str:
    return device_id.split("-", 1)[0].lower()


def _pick_voltage(kind: str, wire, v_ll, v_ln) -> float | None:
    """依接線模式選電壓維度：L-L only 接線取線電壓，否則相電壓優先。"""
    ll_only = WIRE_LL_ONLY_BY_KIND.get(kind, set())
    if wire is not None and int(wire) in ll_only:
        return v_ll
    if v_ln and v_ln > 0:
        return v_ln
    return v_ll


def _nearest_nominal(v: float) -> tuple[float, float]:
    n = min(NOMINALS, key=lambda x: abs(v - x))
    return n, abs(v - n) / n * 100.0


def _evaluate_unit(unit: str, wire, pri, sec, v: float | None) -> list[dict]:
    """回傳該量測單元觸發的規則清單（可能多條）。"""
    hits: list[dict] = []
    if v is None or v < MIN_VOLTAGE or not pri:
        return hits

    nominal, dev_pct = _nearest_nominal(v)
    if dev_pct > R1_DEV_PCT:
        hits.append({
            "rule": "voltage_off_nominal", "severity": "warning",
            "msg": (f"⚡ {unit} 顯示電壓 {v:.0f}V 偏離最近標稱 {nominal:.0f}V 達 {dev_pct:.0f}%"
                    f"（門檻 {R1_DEV_PCT:.0f}%）— 疑 PT 檔位量級設錯或接線異常，請核對設定與接線"),
            "detail": {"voltage": v, "nominal": nominal, "dev_pct": round(dev_pct, 1)},
        })
    if pri >= 3000 and sec and abs(sec - 110.0) > 1.0:
        hits.append({
            "rule": "hv_pt_secondary_nonstd", "severity": "info",
            "msg": (f"🔍 {unit} 高壓表 PT 設定 {pri:.0f}/{sec:.0f} — 台灣高壓 PT 二次標準為 110V，"
                    f"現設 {sec:.0f}V，請核對 PT 銘牌（若銘牌為 110 則量測有 {abs(sec-110)/110*100:.0f}% 系統性偏差）"),
            "detail": {"pt_primary": pri, "pt_secondary": sec},
        })
    if sec and abs(pri - sec) < 0.5 and abs(v - pri) / pri * 100.0 > R3_DEV_PCT:
        hits.append({
            "rule": "rated_mismatch", "severity": "info",
            "msg": (f"📋 {unit} 額定檔位申報 {pri:.0f}V 與實測 {v:.0f}V 不符（直讀表不影響量測，"
                    f"建議校正設定檔位以利稽核）"),
            "detail": {"rated": pri, "voltage": v},
        })
    return hits


async def _collect_violations(db) -> dict[tuple[str, str], dict]:
    """全 fleet 評估 → {(unit, rule): hit}。"""
    rows = (await db.execute(
        text(_LATEST_SQL).bindparams(params=PARAMS)
    )).all()
    dev: dict[str, dict[str, float]] = {}
    for device_id, pcode, value in rows:
        dev.setdefault(device_id, {})[pcode] = float(value)

    out: dict[tuple[str, str], dict] = {}
    for device_id, p in dev.items():
        kind = _kind_of(device_id)
        units: list[tuple[str, dict]] = []
        if "pt_primary" in p:  # CPM 類（cpm12d/cpm23）
            units.append((device_id, {
                "wire": p.get("sys_wire"), "pri": p["pt_primary"], "sec": p.get("pt_secondary"),
                "v": _pick_voltage(kind, p.get("sys_wire"), p.get("voltage_ll_avg"), p.get("voltage_ln_avg")),
            }))
        for m in ("ma", "mb"):  # AEM-DRB 主表（branch 繼承 main）
            if f"{m}_pt_primary" in p:
                units.append((f"{device_id}/{m}", {
                    "wire": p.get(f"{m}_sys_wire"), "pri": p[f"{m}_pt_primary"],
                    "sec": p.get(f"{m}_pt_secondary"),
                    "v": _pick_voltage(kind, p.get(f"{m}_sys_wire"), p.get(f"{m}_u_avg"), p.get(f"{m}_v_avg")),
                }))
        for unit, u in units:
            for hit in _evaluate_unit(unit, u["wire"], u["pri"], u["sec"], u["v"]):
                out[(unit, hit["rule"])] = hit
    return out


async def pt_sanity_tick(session_factory: async_sessionmaker) -> None:
    async with session_factory() as db:
        violations = await _collect_violations(db)

        open_rows = (await db.execute(text("""
            SELECT event_id, data_json->>'unit' AS unit, data_json->>'rule' AS rule
            FROM ems_events
            WHERE source = 'pt_sanity_watcher' AND resolved_at IS NULL
        """))).all()
        open_map = {(r[1], r[2]): r[0] for r in open_rows}

        # 新違規 → 開單（notify_pananora=FALSE：觀察期只記不發信）
        for key, hit in violations.items():
            if key in open_map:
                continue
            unit, rule = key
            data = {"kind": "pt_ct_sanity", "unit": unit, "rule": rule,
                    "device_id": unit.split("/")[0], **hit["detail"]}
            await db.execute(text("""
                INSERT INTO ems_events (ts, event_kind, severity, device_id, message, data_json,
                                        source, notify_pananora)
                VALUES (NOW(), 'operation', :sev, :dev, :msg, CAST(:dj AS jsonb),
                        'pt_sanity_watcher', FALSE)
            """), {"sev": hit["severity"], "dev": unit.split("/")[0], "msg": hit["msg"],
                   "dj": json.dumps(data, ensure_ascii=False)})
            log.warning("pt_sanity: 開單 %s/%s — %s", unit, rule, hit["msg"])

        # 違規消失 → resolve 自己的單
        for key, event_id in open_map.items():
            if key not in violations:
                await db.execute(text("""
                    UPDATE ems_events
                    SET resolved_at = NOW(), message = message || '（✅ 設定已恢復正常）'
                    WHERE event_id = :eid AND resolved_at IS NULL
                """), {"eid": event_id})
                log.warning("pt_sanity: resolve %s/%s（#%s）", key[0], key[1], event_id)

        await db.commit()
        if violations:
            log.info("pt_sanity tick: %d 違規（open %d）", len(violations), len(open_map))


async def pt_sanity_watcher_loop(session_factory: async_sessionmaker) -> None:
    if os.getenv("PT_SANITY_WATCHER", "1") != "1":
        log.info("pt_sanity_watcher disabled（PT_SANITY_WATCHER!=1）")
        return
    log.info("pt_sanity_watcher_loop started (tick=%ss R1>%s%% R3>%s%%; A6-② 觀察期不發信)",
             TICK_SEC, R1_DEV_PCT, R3_DEV_PCT)
    while True:
        try:
            await pt_sanity_tick(session_factory)
        except Exception as e:  # pragma: no cover — DB 短暫不可用等，下輪重試
            log.exception("pt_sanity tick failed: %s", e)
        await asyncio.sleep(TICK_SEC)
