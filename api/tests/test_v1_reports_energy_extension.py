"""T-Reports-001 backend 擴: /v1/reports/energy UT (M-PM-094 §三 改派 P12_sessionA).

擴充項：
- granularity 加 5min / 1hr；舊 daily/monthly 視為 alias 對 1day/1month
- parameter_codes: List[str]（多 metric 一次 call）；舊 parameter_code 保留 deprecated alias
- circuit_id 可選 filter（AEM-DRB1 per-circuit；prefix LIKE）

Test cases (5 per M-PM-093 §3.2.3):
- A: 5min granularity 多 metric 一次 call → trx_reading time_bucket path
- B: circuit_id filter 對 AEM-DRB1 ba1 only → parameter_code LIKE 'ba1_%'
- C: parameter_codes 空 list → 422 (validation)
- D: granularity invalid → 422
- E: from_ts >= to_ts → 422 (繼承 [[M-P12-024]] §五 datetime tz pattern)

Note: 完整 UT 需 testcontainers + asyncpg + db fixture (M-PM-065 §四例外條款；
container 無 pytest 套件未跑)。本檔記錄 UT design + 純邏輯 standalone tests
留 commit 軌跡 (繼承 T-S11C-001/T-S11C-002 條款)。
"""

from __future__ import annotations

from app.routers.v1_reports import (
    _GRANULARITY_ALIAS,
    _BUCKET_INTERVAL,
    _CAGG_VIEW,
    _VALID_GRANULARITY,
)


# ===== 純邏輯：常數對齊 =====

def test_granularity_alias_daily_to_1day():
    """向下相容：daily → 1day, monthly → 1month."""
    assert _GRANULARITY_ALIAS["daily"] == "1day"
    assert _GRANULARITY_ALIAS["monthly"] == "1month"


def test_valid_granularity_includes_5min_1hr():
    """T-Reports-001 新增 granularity."""
    assert "5min" in _VALID_GRANULARITY
    assert "1hr" in _VALID_GRANULARITY
    assert "15min" in _VALID_GRANULARITY
    assert "1day" in _VALID_GRANULARITY
    # 向下相容 alias
    assert "daily" in _VALID_GRANULARITY
    assert "monthly" in _VALID_GRANULARITY


def test_bucket_interval_5min_1hr():
    """5min/1hr 走 trx_reading time_bucket path."""
    assert _BUCKET_INTERVAL["5min"] == "5 minutes"
    assert _BUCKET_INTERVAL["1hr"] == "1 hour"


def test_cagg_view_15min_1day_1month():
    """15min/1day/1month 走 cagg view path."""
    assert _CAGG_VIEW["15min"] == ("cagg_reading_15min", "bucket_15m")
    assert _CAGG_VIEW["1day"] == ("cagg_reading_daily", "bucket_day")
    assert _CAGG_VIEW["1month"] == ("cagg_reading_monthly", "bucket_month")


def test_5min_1hr_not_in_cagg_view():
    """5min/1hr 必走 trx_reading；不可誤走 cagg."""
    assert "5min" not in _CAGG_VIEW
    assert "1hr" not in _CAGG_VIEW


# ===== UT design pattern (給 future sprint 補 fixture 用) =====

async def test_case_a_5min_multi_metric(async_client, sample_trx_aem_data):
    """Case A: 5min granularity 多 metric 一次 call.

    Setup:
        - INSERT trx_reading aem_drb-* with parameter_codes ['ba1_p', 'ba1_pf', 'ba1_s'] over 1 hr

    Expected:
        - GET /v1/reports/energy?granularity=5min&parameter_codes=ba1_p&parameter_codes=ba1_pf
              &parameter_codes=ba1_s&from_ts=...&to_ts=...
        - 200; points 含 12 buckets × 3 parameter_code = 36 rows
        - first_value/last_value/energy_delta = None (5min 路徑不算累積)
    """
    pass


async def test_case_b_circuit_id_filter(async_client, sample_trx_aem_full_circuits):
    """Case B: circuit_id='ba1' → 只回 parameter_code LIKE 'ba1_%'.

    Setup:
        - INSERT 24 路 trx_reading (ba1_p, ba2_p, ..., bb12_p)

    Expected:
        - GET /v1/reports/energy?granularity=15min&circuit_id=ba1&...
        - 只回 ba1_* 的 row；ba2/bb12 不出現
    """
    pass


async def test_case_c_empty_parameter_codes_422(async_client):
    """Case C: parameter_codes 空 list → 422."""
    pass


async def test_case_d_invalid_granularity_422(async_client):
    """Case D: granularity invalid → 422."""
    pass


async def test_case_e_from_ts_ge_to_ts_422(async_client):
    """Case E: from_ts >= to_ts → 422."""
    pass


async def test_case_f_legacy_parameter_code_str_alias(async_client, sample_data):
    """Case F (向下相容): 舊 parameter_code: str 仍可用 (deprecated alias).

    Expected:
        - GET /v1/reports/energy?granularity=15min&parameter_code=tot_input_active_energy&...
        - 200 (與 parameter_codes=['tot_input_active_energy'] 等價)
    """
    pass


async def test_case_g_5min_ecsu_group_422(async_client):
    """Case G: granularity=5min + group_by=ecsu → 422 (path not supported).

    升報邊界：若客戶要 5min ecsu group → 升報 PM (M-PM-094 §3.3 升報觸發)
    """
    pass
