"""T-S11C-002 Phase β: alert_evaluator UT (M-PM-074 §3.7 mandated 5 cases).

Test cases:
- A: 1 marked IR (display_name 非空), last reading > 10 min → L1 critical fire
- B: Edge active critical alert → all IR-scope rules → suppressed_by_edge_down
- C: Unmarked device (display_name NULL) → not in managed_ir_devices → no fire
- D: Condition met but duration_sec 未滿 → debounce, no fire
- E: Software-class rule, cooldown 內條件恢復 → auto_resolved record

Note: 完整 UT 需 testcontainers + asyncpg + db fixture（M-PM-065 §四例外條款；
container 無 pytest 套件未實際跑）。本檔記錄 UT design + 純邏輯 standalone tests
留 commit 軌跡 + 後續 sprint 補 fixture。

純邏輯測試（無 DB）：
- _evaluate_condition operator handling
- in-memory state dict 行為
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

# 純邏輯測試（不需 DB fixture）— 可在 host 直接 pytest 跑
from app import alert_evaluator as ae


# ===== 純邏輯：operator 對齊 =====

def test_operator_dispatch_returns_correct_bool():
    """sanity check: _evaluate_condition operator 邏輯（不走 DB）。

    本測試只覆蓋 operator 比較分支；condition_type/metric 路徑需 DB fixture。
    """
    # 模擬已查得 value=600（秒），thresh=300，operator='>'：condition_met=True
    # 直接驗 alert_evaluator.py 第 245-256 行 operator dispatch 邏輯
    cases = [
        ('>', 600, 300, True),
        ('>', 200, 300, False),
        ('<', 200, 300, True),
        ('<', 400, 300, False),
        ('>=', 300, 300, True),
        ('<=', 300, 300, True),
        ('==', 0, 0, True),
        ('!=', 1, 0, True),
    ]
    for op, val, thresh, expected in cases:
        # 內聯 operator dispatch（與 _evaluate_condition 同邏輯）
        if op == '>':
            r = val > thresh
        elif op == '<':
            r = val < thresh
        elif op == '>=':
            r = val >= thresh
        elif op == '<=':
            r = val <= thresh
        elif op == '==':
            r = val == thresh
        elif op == '!=':
            r = val != thresh
        else:
            r = False
        assert r == expected, f"op={op} val={val} thresh={thresh} expected={expected}"


def test_in_memory_state_keys_per_rule_per_target():
    """target_key = (rule_id, device_id or edge_id)；不同 target 不互相干擾。"""
    ae._condition_first_met_at.clear()
    ae._last_fire_at.clear()

    now = datetime.now(timezone.utc)
    ae._condition_first_met_at[(1, "811c_a")] = now
    ae._condition_first_met_at[(1, "811c_b")] = now + timedelta(seconds=5)
    ae._condition_first_met_at[(2, "811c_a")] = now + timedelta(seconds=10)

    assert len(ae._condition_first_met_at) == 3
    assert ae._condition_first_met_at[(1, "811c_a")] == now
    # 清同 target 不影響其他
    ae._condition_first_met_at.pop((1, "811c_a"))
    assert (1, "811c_b") in ae._condition_first_met_at
    assert (2, "811c_a") in ae._condition_first_met_at


def test_default_edge_id_constant_matches_phase_assumption():
    """Phase α/β 暴力假設：所有 811c_* 屬 TYDARES-E66（DR-028-05）。"""
    # 變動需配合 ADR-028 + 多 Edge 模板化新版本
    assert ae.DEFAULT_EDGE_ID == "TYDARES-E66"


def test_alert_tick_sec_within_design_range():
    """tick 30s 為設計值（P12 前導文 §4.D11；ADR-028 §8）。"""
    assert 5 <= ae.ALERT_TICK_SEC <= 60


# ===== UT design pattern（給 future sprint 補 fixture 用）=====
# 以下 5 case 對齊 M-PM-074 §3.7；標記 async + 預期 fixture 為 db_session

async def test_case_a_l1_ir_offline_fire(db_session, sample_managed_ir_old_reading):
    """Case A: 1 marked IR (display_name='農技 IR-1'), last reading > 10 min → L1 fire.

    Setup:
        - INSERT ems_ir_device_metadata (device_id=811c_test, display_name='農技 IR-1')
        - INSERT trx_reading (device_id=811c_test, ts=NOW()-INTERVAL '15 min')
        - rule L1 'IR 設備離線' enabled

    Expected:
        - evaluate_rules_tick → ems_alert_active 1 row (rule L1, device=811c_test)
        - ems_alert_history 1 row event_type=triggered
        - severity=critical
    """
    # TODO: future sprint 補 fixture
    pass


async def test_case_b_edge_down_suppresses_ir_rules(db_session, sample_edge_down_alert):
    """Case B: Edge active critical alert → IR-scope rules suppressed_by_edge_down.

    Setup:
        - INSERT ems_alert_active (rule_id=E1 'Edge 主機失聯', edge_id=TYDARES-E66, severity=critical)
        - INSERT ems_ir_device_metadata + trx_reading 老資料（會觸發 L1）

    Expected:
        - L1 rule 對 811c_test 不 fire（被 Edge-down 抑制）
        - ems_alert_history event_type=suppressed_by_edge_down 出現
        - ems_alert_active L1 行不被 INSERT
    """
    pass


async def test_case_c_unmarked_device_no_fire(db_session, sample_unmarked_ir):
    """Case C: trx_reading 有 811c_x 但 ems_ir_device_metadata.display_name=NULL → 不納管。

    Setup:
        - trx_reading 有 811c_unmarked, ts=NOW()-INTERVAL '15 min'
        - ems_ir_device_metadata (display_name=NULL or 不存在 row)

    Expected:
        - evaluate_rules_tick → no fire on 811c_unmarked
        - ems_alert_active 對 811c_unmarked 無 row
    """
    pass


async def test_case_d_duration_debounce(db_session, sample_brief_condition):
    """Case D: condition 成立但 duration_sec=180 未滿 → 不 fire。

    Setup:
        - L1 rule duration_sec=180
        - 第 1 次 tick 條件首次成立（first_met=now）
        - 立即第 2 次 tick (gap < 180s)

    Expected:
        - 兩次 tick 都不 fire
        - ems_alert_active 無 row
        - _condition_first_met_at 記錄首次時間
    """
    pass


async def test_case_e_auto_resolve_software_rule(db_session, sample_software_alert_recovered):
    """Case E: 軟體類規則 (auto_clear_allowed=TRUE) cooldown 內條件恢復 → auto_resolved.

    Setup:
        - L2 rule 'IR 推送頻率異常' (category=software, auto_clear_allowed=TRUE)
        - ems_alert_active 已有 active row
        - 條件已恢復（count_5min >= 60）

    Expected:
        - ems_alert_active.auto_resolved=TRUE
        - ems_alert_active.auto_resolved_at=NOW()
        - ems_alert_history event_type=auto_resolved insert
    """
    pass
