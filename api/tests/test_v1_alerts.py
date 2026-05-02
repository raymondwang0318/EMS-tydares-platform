"""T-S11C-002 AC 8 (M-PM-085 §3): /v1/alerts/* endpoints UT.

3 endpoints:
- GET /v1/alerts/active     當前 active alerts
- GET /v1/alerts/history    歷史事件流
- PUT /v1/alerts/{id}/ack   手動 ack

Test cases (5 per M-PM-085 §3.3):
- A: active alerts 多 filter (device_id / edge_id / severity)
- B: history 時間區間 + event_type filter (含 'suppressed_by_edge_down')
- C: ack flow (status active→acknowledged + history INSERT + 重複 ack idempotent)
- D: 404 (alert_id 不存在) + 422 (ack_note 過長 / acked_by 必填 / severity invalid)
- E: limit 防爆量 (default 200, max 1000)

Note: 完整 UT 需 testcontainers + asyncpg + db fixture (M-PM-065 §四例外條款；
container 無 pytest 套件未實際跑)。本檔記錄 UT design + Pydantic schema 純邏輯
standalone tests 留 commit 軌跡。
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.routers.v1_alerts import AckRequest, VALID_EVENT_TYPES, VALID_SEVERITIES


# ===== 純邏輯：Pydantic AckRequest =====

def test_ack_request_acked_by_required():
    """acked_by 必填；空字串應 422."""
    with pytest.raises(ValidationError):
        AckRequest(acked_by="", ack_note=None)


def test_ack_request_acked_by_too_long():
    """acked_by max 100 chars."""
    with pytest.raises(ValidationError):
        AckRequest(acked_by="a" * 101, ack_note=None)


def test_ack_request_ack_note_too_long():
    """ack_note max 500 chars."""
    with pytest.raises(ValidationError):
        AckRequest(acked_by="admin", ack_note="x" * 501)


def test_ack_request_ack_note_optional():
    """ack_note=None 合法."""
    req = AckRequest(acked_by="admin", ack_note=None)
    assert req.acked_by == "admin"
    assert req.ack_note is None


def test_ack_request_normal():
    """正常 case."""
    req = AckRequest(acked_by="老王", ack_note="現場確認測試機關閉")
    assert req.acked_by == "老王"
    assert req.ack_note == "現場確認測試機關閉"


# ===== 常數白名單 =====

def test_valid_event_types_includes_suppressed_by_edge_down():
    """ADR-028 §8.2 cross-cutting hook 必須在白名單."""
    assert "suppressed_by_edge_down" in VALID_EVENT_TYPES
    assert len(VALID_EVENT_TYPES) == 6  # P12 前導文 §5.3 6 種


def test_valid_severities_three_levels():
    """P12 前導文 §5.1 三階級."""
    assert set(VALID_SEVERITIES) == {"critical", "warning", "info"}


# ===== UT design pattern (給 future sprint 補 fixture 用) =====

async def test_case_a_active_alerts_filter(async_client, sample_alerts_active):
    """Case A: GET /v1/alerts/active 多 filter (device_id / edge_id / severity).

    Setup:
        - INSERT 3 ems_alert_active (
            (rule=L2 warning device=811c_a edge=E66),
            (rule=L1 critical device=811c_b edge=E66),
            (rule=E1 critical device=NULL edge=E66 auto_resolved=TRUE)  # 應被 exclude
          )

    Expected:
        - GET /v1/alerts/active → 2 rows (auto_resolved=TRUE excluded)
        - GET /v1/alerts/active?device_id=811c_a → 1 row
        - GET /v1/alerts/active?severity=critical → 1 row
        - GET /v1/alerts/active?severity=invalid → 422
    """
    pass


async def test_case_b_history_filter_event_type(async_client, sample_alerts_history):
    """Case B: GET /v1/alerts/history 時間區間 + event_type filter.

    Setup:
        - INSERT history events: triggered, acknowledged, suppressed_by_edge_down, auto_resolved

    Expected:
        - GET /v1/alerts/history → 預設 7d 內全部 ORDER BY ts DESC
        - GET /v1/alerts/history?event_type=suppressed_by_edge_down → 只 suppressed events
        - GET /v1/alerts/history?since=...&until=... → 時間範圍正確
        - GET /v1/alerts/history?event_type=invalid → 422
        - since >= until → 422
    """
    pass


async def test_case_c_ack_flow_idempotent(async_client, sample_active_alert):
    """Case C: PUT /v1/alerts/{id}/ack flow.

    Setup:
        - INSERT 1 active alert (alert_id=99)

    Expected:
        - PUT /v1/alerts/99/ack {acked_by:'老王', ack_note:'測試'} → 200
          - ems_alert_active.status='acknowledged'
          - ems_alert_history INSERT event_type='acknowledged' actor='老王'
        - 第 2 次 PUT /v1/alerts/99/ack → 200 idempotent (status=acknowledged 不重複 history insert)
    """
    pass


async def test_case_d_404_and_422(async_client):
    """Case D: 守門 (404 / 422).

    Expected:
        - PUT /v1/alerts/9999999/ack → 404 (alert_id 不存在)
        - PUT /v1/alerts/1/ack {acked_by:''} → 422 (acked_by 必填)
        - PUT /v1/alerts/1/ack {acked_by:'a'*101} → 422 (max 100)
        - PUT /v1/alerts/1/ack {acked_by:'admin', ack_note:'x'*501} → 422 (max 500)
        - GET /v1/alerts/active?severity=foo → 422
        - GET /v1/alerts/history?event_type=foo → 422
        - GET /v1/alerts/history?limit=9999 → 422 (max 1000)
    """
    pass


async def test_case_e_limit_default_and_max(async_client, sample_history_2000_rows):
    """Case E: limit 防爆量 (default 200, max 1000).

    Setup:
        - INSERT 2000 ems_alert_history rows

    Expected:
        - GET /v1/alerts/history (no limit) → 200 rows (default)
        - GET /v1/alerts/history?limit=500 → 500 rows
        - GET /v1/alerts/history?limit=1000 → 1000 rows
        - GET /v1/alerts/history?limit=1001 → 422
    """
    pass
