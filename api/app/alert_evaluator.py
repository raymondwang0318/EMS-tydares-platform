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

# Multi-Edge phase B (M-PM-110 軌 A②)：edge_id 從 ems_ir_device_metadata 派生
# 對 metadata.edge_id IS NULL row fallback 用 DEFAULT_EDGE_ID（向下相容）
# 後續若 P11 Wizard 強制必填 → 改 NOT NULL 後 fallback 可移除
DEFAULT_EDGE_ID = "TYDARES-E66"

# In-memory state（Phase α/β；多 worker 部署轉 Redis）
_condition_first_met_at: dict[tuple[int, str], datetime] = {}
_last_fire_at: dict[tuple[int, str], datetime] = {}


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
    async with session_factory() as db:
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
        # M-PM-110 軌 A②：edge_id 從 metadata 派生（取代 phase A hardcoded DEFAULT_EDGE_ID）
        # COALESCE 對 metadata.edge_id IS NULL row fallback 為 DEFAULT_EDGE_ID（向下相容）
        managed_irs_rows = (await db.execute(text("""
            SELECT m.device_id, COALESCE(m.edge_id, :default_edge_id) AS edge_id
            FROM ems_ir_device_metadata m
            WHERE m.display_name IS NOT NULL AND m.display_name <> ''
        """), {"default_edge_id": DEFAULT_EDGE_ID})).fetchall()
        managed_ir_devices = [
            {"device_id": row[0], "edge_id": row[1]}
            for row in managed_irs_rows
        ]

        # === 載所有 edges ===
        edges_rows = (await db.execute(text("SELECT edge_id FROM ems_edge"))).fetchall()
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

                    # Auto-resolve（軟體類）
                    if auto_clear_allowed:
                        resolved = await _maybe_auto_resolve(db, rule_id, target_dev, target_edge)
                        if resolved:
                            resolved_count += 1

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
                value = 1.0  # 無資料視為 valid（避免誤報；L1 已負責 offline 判斷）

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
    """UPSERT ems_alert_active + INSERT ems_alert_history triggered."""
    result = await db.execute(text("""
        INSERT INTO ems_alert_active
            (rule_id, device_id, edge_id, trigger_value, trigger_metric,
             message, severity, last_value, last_seen_at)
        VALUES
            (:rule_id, :device_id, :edge_id, :value, :metric,
             :msg, :severity, :value, NOW())
        ON CONFLICT (rule_id, device_id, edge_id) DO UPDATE
        SET last_value = EXCLUDED.last_value,
            last_seen_at = NOW(),
            auto_resolved = FALSE,
            auto_resolved_at = NULL
        RETURNING alert_id
    """), {
        "rule_id": rule_id, "device_id": device_id, "edge_id": edge_id,
        "value": value, "metric": metric,
        "msg": f"{rule_name}: {metric}={value:.2f}",
        "severity": severity,
    })
    alert_id = result.fetchone()[0]

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
    """軟體類規則 + 條件已恢復 → mark active.auto_resolved=TRUE."""
    result = await db.execute(text("""
        UPDATE ems_alert_active
        SET auto_resolved = TRUE,
            auto_resolved_at = NOW(),
            last_seen_at = NOW()
        WHERE rule_id = :rule_id
          AND COALESCE(device_id, '') = COALESCE(:device_id, '')
          AND COALESCE(edge_id, '') = COALESCE(:edge_id, '')
          AND status = 'active'
          AND auto_resolved = FALSE
        RETURNING alert_id
    """), {"rule_id": rule_id, "device_id": device_id, "edge_id": edge_id})
    row = result.fetchone()
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
    log.info(
        "alert auto-resolved: rule_id=%s target=%s/%s",
        rule_id, device_id or '-', edge_id or '-',
    )
    return True
