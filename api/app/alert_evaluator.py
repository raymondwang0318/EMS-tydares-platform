"""T-S11C-002 Phase β: alert rule evaluator (ADR-028 落地).

設計原則（ADR-028 + P12 前導文 §4 D11/D12）:
- 每 30 秒 tick；併入 ems-worker container（asyncio task）
- Edge-down 抑制 hook（每 tick 第一步先查 Edge 級 critical alerts）
- 5 種 custom evaluator + 2 種 offline evaluator
- 抖動抑制：duration_sec / cooldown_sec / auto_clear_allowed
- 應在線清單派生：ems_ir_device_metadata.display_name 非空 → 視為已標記納管

State management（Phase α/β）:
- in-memory dict 追蹤每規則每目標的「條件首次成立時間」+「最近 fire 時間」
- 多 worker 部署需轉 Redis（未來工作）

Reference:
- [[ADR-028-IR-Device-Health-Monitoring-And-Edge-Liveness]] §8.1 §8.2
- [[T-S11C-002]] §AC 3 §3.1-3.8
- [[P12_設備異常警報系統_前導文_2026-04-18]] §4 §5
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker

log = logging.getLogger("alert_evaluator")

ALERT_TICK_SEC = 30.0

# M-PM-323 軌 C：硬體類告警恢復「持續窗口」（防 flap 抖動誤翻綠）。
# IR 對齊 rule1 duration_sec=180；Edge 較長（fleet 復電群體抖動，對齊 alarm_evaluator
# RESOLVE_WINDOW_SEC）。設備/Edge 條件 not-met 須持續超過 grace 才標 auto_resolved 綠燈。
HW_RECOVER_GRACE_IR_SEC = 180.0
HW_RECOVER_GRACE_EDGE_SEC = 300.0

# M-P11-E67/M-P12-109：DEFAULT_EDGE_ID="TYDARES-E66" fallback 已移除——
# E66 為已拆測試機(revoked)，fallback 使 16 台 IR 掛錯 edge → 永久失聯誤報
# + 每 tick suppression history 灌出 443 萬筆。metadata.edge_id 已全 fleet 補值。

# In-memory state（Phase α/β；多 worker 部署轉 Redis）
_condition_first_met_at: dict[tuple[int, str], datetime] = {}
_last_fire_at: dict[tuple[int, str], datetime] = {}
# M-PM-323 軌 C：硬體類「持續恢復起算時間」（key 同 target_key）。
_hw_recover_since: dict[tuple[int, str], datetime] = {}
_initialized = False  # worker 重啟後從 DB 重建 state（防洗版）


async def alert_evaluator_loop(session_factory: async_sessionmaker) -> None:
    """主 loop。每 30s 跑 evaluate_rules_tick；異常不終止 loop。"""
    log.info("alert_evaluator_loop started (tick=%ss; T-S11C-002 ADR-028)", ALERT_TICK_SEC)
    while True:
        try:
            await evaluate_rules_tick(session_factory)
        except Exception as e:
            log.exception("alert_evaluator tick failed: %s", e)
        await asyncio.sleep(ALERT_TICK_SEC)


async def evaluate_rules_tick(session_factory: async_sessionmaker) -> None:
    """單次 tick；ADR-028 §8.2 完整實作。"""
    global _initialized
    async with session_factory() as db:
        # M-PM-323 軌 C：worker 重啟後從 DB 重建 in-memory state（防洗版）
        if not _initialized:
            await _init_state_from_db(db)
            _initialized = True

        # === Step 1: Edge-down 抑制集 ===
        result = await db.execute(text("""
            SELECT DISTINCT a.edge_id
            FROM ems_alert_active a
            JOIN ems_alert_rule r ON a.rule_id = r.rule_id
            WHERE r.scope = 'edge'
              AND r.severity = 'critical'
              AND a.status = 'active'
              AND a.auto_resolved = FALSE
              AND a.edge_id IS NOT NULL
        """))
        suppressed_edge_ids: set[str] = {row[0] for row in result.fetchall()}

        if suppressed_edge_ids:
            log.info("Edge-down suppression active: %s", suppressed_edge_ids)

        # === Step 2: 載 enabled rules ===
        rules = (await db.execute(text("""
            SELECT rule_id, rule_name, category, auto_clear_allowed,
                   scope, device_id, edge_id, device_kind,
                   condition_type, metric, operator, threshold_value,
                   duration_sec, severity, cooldown_sec
            FROM ems_alert_rule
            WHERE enabled = TRUE AND deleted_at IS NULL
            ORDER BY rule_id
        """))).fetchall()

        # === Step 3: 載 managed IR devices（display_name 非空 + per-device edge_id）===
        # M-PM-110 軌 A②：edge_id 從 metadata 派生；M-P12-109 移除 E66 fallback
        # （edge_id NULL → 不做 Edge-down 抑制，照常獨立評估）
        managed_irs_rows = (await db.execute(text("""
            SELECT m.device_id, m.edge_id
            FROM ems_ir_device_metadata m
            WHERE m.display_name IS NOT NULL AND m.display_name <> ''
        """))).fetchall()
        managed_ir_devices = [
            {"device_id": row[0], "edge_id": row[1]}
            for row in managed_irs_rows
        ]

        # === 載 edges（M-P12-109 斷根第一刀：revoked 不評估，否則對已拆機永久誤報）===
        edges_rows = (await db.execute(text(
            "SELECT edge_id FROM ems_edge WHERE status NOT IN ('revoked')"
        ))).fetchall()
        edge_ids = [row[0] for row in edges_rows]

        # === Step 4: 對每 rule 跑 ===
        fired_count = 0
        suppressed_count = 0
        resolved_count = 0
        for rule in rules:
            (rule_id, rule_name, category, auto_clear_allowed,
             scope, scope_dev, scope_edge, scope_kind,
             cond_type, metric, operator, thresh_val,
             duration_sec, severity, cooldown_sec) = rule

            # Resolve targets
            if scope == 'edge':
                targets = [{"edge_id": eid, "device_id": None} for eid in edge_ids]
            elif scope == 'device_kind' and scope_kind == '811c':
                targets = managed_ir_devices  # 已過濾 display_name 非空
            else:
                continue  # 其他 scope 暫不支援

            for target in targets:
                target_dev = target["device_id"]
                target_edge = target["edge_id"]
                target_key = (rule_id, target_dev or target_edge or "")

                # Step 5: Edge-down 抑制
                if scope in ('device', 'device_kind') and target_edge in suppressed_edge_ids:
                    await _record_suppression(
                        db, rule_id, target_dev, target_edge, severity, rule_name
                    )
                    suppressed_count += 1
                    continue

                # Step 6: evaluate condition
                value, condition_met = await _evaluate_condition(
                    db, cond_type, metric, operator, thresh_val,
                    target_dev, target_edge
                )

                # Step 7: duration 抖動抑制
                now = datetime.now(timezone.utc)
                if condition_met:
                    # M-PM-323 軌 C：設備又異常 → 重置硬體恢復計時（重置點放最外層，
                    # 確保 cooldown continue 早退出時 grace 也被清，防 flap 殘留誤翻綠）
                    _hw_recover_since.pop(target_key, None)
                    first_met = _condition_first_met_at.get(target_key)
                    if first_met is None:
                        _condition_first_met_at[target_key] = now
                        if duration_sec > 0:
                            continue  # 第一次成立；等 duration
                    else:
                        if duration_sec > 0 and (now - first_met).total_seconds() < duration_sec:
                            continue

                    # Step 8: cooldown
                    last_fire = _last_fire_at.get(target_key)
                    if last_fire and (now - last_fire).total_seconds() < cooldown_sec:
                        continue

                    # Fire
                    await _fire_alert(
                        db, rule_id, rule_name, target_dev, target_edge,
                        value, metric, severity
                    )
                    _last_fire_at[target_key] = now
                    fired_count += 1

                else:
                    # Condition not met
                    _condition_first_met_at.pop(target_key, None)

                    if auto_clear_allowed:
                        # 軟體類：條件恢復 → 直接 DELETE active（M-PM-323 軌 C 杜絕 rule6 式 ghost）
                        _hw_recover_since.pop(target_key, None)
                        resolved = await _maybe_auto_resolve(db, rule_id, target_dev, target_edge)
                        if resolved:
                            resolved_count += 1
                    else:
                        # 硬體類（M-PM-323 軌 C 治本核心）
                        # ⚠️ value=None（查無資料）硬隔離：不啟動 grace、維持紅燈等人 clear——
                        # 保 TC04 靜默型（ping 通但 trx 無 frame）送原廠樣本不被誤翻綠。
                        if value is None:
                            _hw_recover_since.pop(target_key, None)
                        else:
                            # 持續恢復窗口 grace（IR 180s / Edge 300s）→ 超過才自動 DELETE
                            # （直接綠燈回正常；人工留痕移至歷史頁 read_at/read_by 已讀確認）
                            grace = (HW_RECOVER_GRACE_EDGE_SEC if scope == 'edge'
                                     else HW_RECOVER_GRACE_IR_SEC)
                            first_ok = _hw_recover_since.get(target_key)
                            if first_ok is None:
                                _hw_recover_since[target_key] = now
                            elif (now - first_ok).total_seconds() >= grace:
                                recovered = await _maybe_recover_hardware(
                                    db, rule_id, target_dev, target_edge)
                                if recovered:
                                    resolved_count += 1
                                    _hw_recover_since.pop(target_key, None)

        await db.commit()

        # tick log
        log.info(
            "evaluator tick: rules=%d managed_ir=%d edges=%d "
            "fired=%d suppressed=%d resolved=%d",
            len(rules), len(managed_ir_devices), len(edge_ids),
            fired_count, suppressed_count, resolved_count,
        )


async def _evaluate_condition(
    db, cond_type: str, metric: str, operator: str, thresh: float,
    device_id: str | None, edge_id: str | None,
) -> tuple[Any, bool]:
    """回 (value, condition_met)。value=None 表查不到資料。"""
    value: Any = None

    if cond_type == 'offline':
        if metric == 'last_seen_at':  # E1 Edge offline
            row = (await db.execute(text("""
                SELECT EXTRACT(EPOCH FROM (NOW() - last_seen_at)) AS lag
                FROM ems_edge WHERE edge_id = :edge_id
            """), {"edge_id": edge_id})).fetchone()
            value = float(row[0]) if row and row[0] is not None else None
        elif metric == 'last_seen_received_at':  # L1 IR offline
            row = (await db.execute(text("""
                SELECT EXTRACT(EPOCH FROM (NOW() - MAX(ts))) AS lag
                FROM trx_reading WHERE device_id = :device_id
            """), {"device_id": device_id})).fetchone()
            value = float(row[0]) if row and row[0] is not None else None

    elif cond_type == 'custom':
        if metric == 'count_5min':  # L2 IR push frequency
            row = (await db.execute(text("""
                SELECT COUNT(*) FROM trx_reading
                WHERE device_id = :device_id AND ts > NOW() - INTERVAL '5 minutes'
            """), {"device_id": device_id})).fetchone()
            value = float(row[0]) if row else 0.0

        elif metric == 'data_validity':  # L3 IR data validity
            # 簡化：查最近一筆 max_temp 是否在 -20~250；卡幀偵測待 Edge data_quality_flag
            row = (await db.execute(text("""
                SELECT value FROM trx_reading
                WHERE device_id = :device_id AND parameter_code = 'max_temp'
                ORDER BY ts DESC LIMIT 1
            """), {"device_id": device_id})).fetchone()
            if row and row[0] is not None:
                temp = float(row[0])
                # 0=invalid (out of range), 1=valid
                value = 0.0 if (temp < -20 or temp > 250) else 1.0
            else:
                # 無資料視為 valid（避免誤報；rule1 offline 專責靜默判斷）。
                # ⚠️ M-PM-323v2 顯式契約：此 1.0 也刻意確保 rule3 不對「靜默裝置」fire——
                # 否則靜默 TC04 會經 rule3 value 0→1 恢復走 _maybe_recover_hardware 自動 DELETE，
                # 破壞 TC04 送原廠樣本紅燈保護。若未來把「無資料」改判 invalid(0.0)（卡幀偵測
                # data_quality_flag），必須同步在 not-met 硬體分支對此 metric 比照 offline 做
                # value=None 等價隔離，否則鐵律破。
                value = 1.0

        elif metric == 'ts_drift_sec':  # L4 IR ts drift
            # ADR-028 已 note：Pi RTC 漂移由 server-side ts 已迴避；本 evaluator stub 回 0
            value = 0.0

        elif metric == 'hb_gap_sec':  # E2 Edge heartbeat gap
            # ADR-026 V2-final 欄位：ems_edge_heartbeat 用 hb_ts（非 ts）
            row = (await db.execute(text("""
                SELECT EXTRACT(EPOCH FROM (NOW() - MAX(hb_ts))) AS gap
                FROM ems_edge_heartbeat WHERE edge_id = :edge_id
            """), {"edge_id": edge_id})).fetchone()
            value = float(row[0]) if row and row[0] is not None else None

        elif metric == 'config_drift_sec':  # E3 Edge config drift
            # 簡化 stub：完整實作需對比 ems_edge_heartbeat.config_version 與 ems_edge.config_version
            # 本卡 phase β 暫回 0；ADR-028 §後果已備註
            value = 0.0

    if value is None:
        return None, False

    # Operator check
    if operator == '>':
        return value, value > thresh
    elif operator == '<':
        return value, value < thresh
    elif operator == '>=':
        return value, value >= thresh
    elif operator == '<=':
        return value, value <= thresh
    elif operator == '==':
        return value, value == thresh
    elif operator == '!=':
        return value, value != thresh
    return value, False


async def _record_suppression(
    db, rule_id: int, device_id: str | None, edge_id: str | None,
    severity: str, rule_name: str,
) -> None:
    """寫 ems_alert_history event_type='suppressed_by_edge_down'.

    無 active row → alert_id=0 占位（PRIMARY KEY (ts, alert_id, event_type)）。
    """
    # 注意：同 tick 多 device 抑制會在同 NOW()（transaction_timestamp）撞 PK,
    # 用 clock_timestamp() 確保每筆不同 ts。
    await db.execute(text("""
        INSERT INTO ems_alert_history
            (ts, alert_id, rule_id, event_type, device_id, edge_id, severity, message, actor)
        VALUES
            (clock_timestamp(), 0, :rule_id, 'suppressed_by_edge_down',
             :device_id, :edge_id, :severity, :msg, 'system')
        ON CONFLICT DO NOTHING
    """), {
        "rule_id": rule_id, "device_id": device_id, "edge_id": edge_id,
        "severity": severity,
        "msg": f"Suppressed: edge {edge_id} down ({rule_name})",
    })


async def _fire_alert(
    db, rule_id: int, rule_name: str,
    device_id: str | None, edge_id: str | None,
    value: float, metric: str, severity: str,
) -> None:
    """UPSERT ems_alert_active + INSERT ems_alert_history triggered.

    ⚠️ M-P12-109：原 ON CONFLICT (rule_id, device_id, edge_id) 對 edge 級告警
    （device_id=NULL）永遠不衝突（PG UNIQUE 視 NULL 相異）→ 每次 fire 插新列
    → alert_active 只進不出（E04 曾堆 682 筆）。改手動 UPDATE→INSERT
    （IS NOT DISTINCT FROM 正確匹配 NULL；單一 evaluator 實例無 race）。
    """
    row = (await db.execute(text("""
        UPDATE ems_alert_active
        SET last_value = :value,
            last_seen_at = NOW(),
            auto_resolved = FALSE,
            auto_resolved_at = NULL
        WHERE rule_id = :rule_id
          AND device_id IS NOT DISTINCT FROM :device_id
          AND edge_id IS NOT DISTINCT FROM :edge_id
        RETURNING alert_id
    """), {
        "rule_id": rule_id, "device_id": device_id, "edge_id": edge_id,
        "value": value,
    })).fetchone()
    if row is None:
        row = (await db.execute(text("""
            INSERT INTO ems_alert_active
                (rule_id, device_id, edge_id, trigger_value, trigger_metric,
                 message, severity, last_value, last_seen_at)
            VALUES
                (:rule_id, :device_id, :edge_id, :value, :metric,
                 :msg, :severity, :value, NOW())
            RETURNING alert_id
        """), {
            "rule_id": rule_id, "device_id": device_id, "edge_id": edge_id,
            "value": value, "metric": metric,
            "msg": f"{rule_name}: {metric}={value:.2f}",
            "severity": severity,
        })).fetchone()
    alert_id = row[0]

    await db.execute(text("""
        INSERT INTO ems_alert_history
            (ts, alert_id, rule_id, event_type, device_id, edge_id,
             value, message, severity, actor)
        VALUES
            (NOW(), :alert_id, :rule_id, 'triggered', :device_id, :edge_id,
             :value, :msg, :severity, 'system')
    """), {
        "alert_id": alert_id, "rule_id": rule_id,
        "device_id": device_id, "edge_id": edge_id,
        "value": value, "msg": f"{rule_name} triggered",
        "severity": severity,
    })

    log.info(
        "alert fired: rule=%s target=%s/%s value=%s",
        rule_name, device_id or '-', edge_id or '-', value,
    )


async def _maybe_auto_resolve(
    db, rule_id: int, device_id: str | None, edge_id: str | None,
) -> bool:
    """軟體類規則 + 條件已恢復 → INSERT history(auto_resolved) + DELETE active.

    M-PM-323 軌 C：改為直接 DELETE（原為翻 auto_resolved=TRUE flag），杜絕 rule6 式
    ghost（auto_resolved=TRUE 但 status=active 永久殘留——list_active 用
    auto_resolved=FALSE 隱藏但表內無限堆積）。history 'auto_resolved' 事件保留審計軌。
    NULL 匹配統一 IS NOT DISTINCT FROM（對齊 _fire_alert）。
    """
    row = (await db.execute(text("""
        SELECT alert_id FROM ems_alert_active
        WHERE rule_id = :rule_id
          AND device_id IS NOT DISTINCT FROM :device_id
          AND edge_id IS NOT DISTINCT FROM :edge_id
          AND status IN ('active', 'acknowledged')
        LIMIT 1
    """), {"rule_id": rule_id, "device_id": device_id, "edge_id": edge_id})).fetchone()
    if not row:
        return False

    alert_id = row[0]
    await db.execute(text("""
        INSERT INTO ems_alert_history
            (ts, alert_id, rule_id, event_type, device_id, edge_id, severity, actor)
        VALUES
            (NOW(), :alert_id, :rule_id, 'auto_resolved',
             :device_id, :edge_id, 'info', 'system')
    """), {
        "alert_id": alert_id, "rule_id": rule_id,
        "device_id": device_id, "edge_id": edge_id,
    })
    await db.execute(
        text("DELETE FROM ems_alert_active WHERE alert_id = :alert_id"),
        {"alert_id": alert_id})
    log.info(
        "alert auto-resolved (deleted): rule_id=%s target=%s/%s",
        rule_id, device_id or '-', edge_id or '-',
    )
    return True


async def _maybe_recover_hardware(
    db, rule_id: int, device_id: str | None, edge_id: str | None,
) -> bool:
    """硬體類規則 + 條件持續恢復（已過 grace）→ INSERT history(auto_resolved) + DELETE active.

    M-PM-323 軌C v2（老王 2026-06-17 拍板）：硬體連線恢復改「直接綠燈」＝grace 後自動
    DELETE（原為標 auto_resolved=TRUE 綠燈停留 active 待人 clear）。active 表只反映當前
    真實異常，恢復即回正常綠燈；人工治理留痕改由 ems_alert_history.read_at/read_by
    「人工讀取確認」承擔（移至歷史頁回顧確認，不卡 active）。rule1/3/5 全硬體類一致適用。
    ⚠️ value=None（查無資料）已於呼叫前硬隔離（TC04 靜默型不進此路徑，紅燈保送原廠樣本）；
    grace（IR 180s / Edge 300s）仍在呼叫端把關，防 fleet 復電群體抖動誤刪。
    NULL 匹配統一 IS NOT DISTINCT FROM（rule5 edge 級 device_id=NULL 必須這樣才匹配）。
    """
    row = (await db.execute(text("""
        SELECT alert_id FROM ems_alert_active
        WHERE rule_id = :rule_id
          AND device_id IS NOT DISTINCT FROM :device_id
          AND edge_id IS NOT DISTINCT FROM :edge_id
          AND status IN ('active', 'acknowledged')
        LIMIT 1
    """), {"rule_id": rule_id, "device_id": device_id, "edge_id": edge_id})).fetchone()
    if not row:
        return False

    alert_id = row[0]
    await db.execute(text("""
        INSERT INTO ems_alert_history
            (ts, alert_id, rule_id, event_type, device_id, edge_id, severity, message, actor)
        VALUES
            (NOW(), :alert_id, :rule_id, 'auto_resolved', :device_id, :edge_id,
             'info', '硬體連線恢復，自動解除（歷史頁可人工讀取確認）', 'system')
    """), {
        "alert_id": alert_id, "rule_id": rule_id,
        "device_id": device_id, "edge_id": edge_id,
    })
    await db.execute(
        text("DELETE FROM ems_alert_active WHERE alert_id = :alert_id"),
        {"alert_id": alert_id})
    log.info(
        "hardware alert recovered (deleted, grace passed): rule_id=%s target=%s/%s",
        rule_id, device_id or '-', edge_id or '-',
    )
    return True


async def _init_state_from_db(db) -> None:
    """worker 重啟後從 DB 未解除告警重建 in-memory state（防洗版）.

    M-PM-323 軌C v2（老王 2026-06-17）：硬體恢復改 grace 後直接 DELETE，active 不再有
    auto_resolved=TRUE 綠燈停留 row → _hw_recover_since 為純記憶體 in-flight grace 計時，
    無從 DB 重建（worker 重啟後對仍在恢復的目標自然重新起算 grace，最壞多等一個 grace，
    無害）。僅重建 _last_fire_at（用 active 的 last_seen_at 近似，防重啟對真離線瞬間重 fire 洗版）。
    """
    rows = (await db.execute(text("""
        SELECT rule_id, device_id, edge_id, last_seen_at
        FROM ems_alert_active
        WHERE status IN ('active', 'acknowledged') AND auto_resolved = FALSE
    """))).fetchall()
    n_fire = 0
    for rule_id, device_id, edge_id, last_seen_at in rows:
        key = (rule_id, device_id or edge_id or "")
        if last_seen_at is not None:
            _last_fire_at[key] = last_seen_at
            n_fire += 1
    log.info("alert_evaluator state rebuilt: last_fire=%d", n_fire)
