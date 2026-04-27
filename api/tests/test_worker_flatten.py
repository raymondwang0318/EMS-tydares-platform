"""T-P12-009: worker.py _flatten_modbus / _flatten_ir UT.

Bug fix (T-P12-009): 原 _flatten_modbus 的 fallback flat 分支 `for k, v in payload.items()`
把 V2-final IngestRecord {"metric": <code>, "value": <num>} 的 dict key "value"
當 parameter_code 寫入，導致 trx_reading 240K rows 全部 parameter_code='value'。
本測試覆蓋 fix 後的多分支 + 守門邏輯。
"""

from datetime import datetime, timezone

from app.worker import _flatten_ir, _flatten_modbus

FIXED_TS = datetime(2026, 4, 25, 12, 0, 0, tzinfo=timezone.utc)


# ===== _flatten_modbus V2-final =====

def test_flatten_modbus_v2_final_metric_value_pair():
    """T-P12-009 核心：V2-final IngestRecord {metric, value, unit} 正規路徑。"""
    payload = {"metric": "bb12_pf", "value": 1.0, "unit": ""}
    rows = _flatten_modbus(payload, FIXED_TS, "cpm12d-test-slave1")
    assert len(rows) == 1
    # bug fix 重點：parameter_code 取 metric 不是 dict key 'value'
    assert rows[0]["parameter_code"] == "bb12_pf"
    assert rows[0]["value"] == 1.0
    assert rows[0]["circuit_code"] == "Ma"  # default
    assert rows[0]["device_id"] == "cpm12d-test-slave1"
    assert rows[0]["ts"] == FIXED_TS


def test_flatten_modbus_v2_final_with_explicit_circuit_code():
    """V2-final 帶顯式 circuit_code → 採用該值。"""
    payload = {"metric": "voltage", "value": 220.5, "unit": "V", "circuit_code": "Ba1"}
    rows = _flatten_modbus(payload, FIXED_TS, "device-x")
    assert len(rows) == 1
    assert rows[0]["parameter_code"] == "voltage"
    assert rows[0]["circuit_code"] == "Ba1"
    assert rows[0]["value"] == 220.5


def test_flatten_modbus_v2_final_invalid_value_silent_skip():
    """V2-final 但 value 非 numeric → silent skip 不寫 row。"""
    payload = {"metric": "voltage", "value": "not_a_number", "unit": "V"}
    rows = _flatten_modbus(payload, FIXED_TS, "device-x")
    assert rows == []


def test_flatten_modbus_v2_final_int_value():
    """value 為 int 也接受（converted to float）。"""
    payload = {"metric": "active_power", "value": 120, "unit": "W"}
    rows = _flatten_modbus(payload, FIXED_TS, "device-x")
    assert len(rows) == 1
    assert rows[0]["value"] == 120.0
    assert isinstance(rows[0]["value"], float)


# ===== _flatten_modbus 歷史 circuits 巢狀 =====

def test_flatten_modbus_circuits_nested_multiple():
    """歷史 circuits 巢狀格式仍可運作。"""
    payload = {"circuits": {"Ma": {"voltage": 220.5, "current": 5.2}, "Ba1": {"voltage": 110.0}}}
    rows = _flatten_modbus(payload, FIXED_TS, "device-x")
    assert len(rows) == 3
    by_pcode = {(r["circuit_code"], r["parameter_code"]): r["value"] for r in rows}
    assert by_pcode[("Ma", "voltage")] == 220.5
    assert by_pcode[("Ma", "current")] == 5.2
    assert by_pcode[("Ba1", "voltage")] == 110.0


def test_flatten_modbus_circuits_skip_non_dict_circuit():
    """circuits 內非 dict 值 skip。"""
    payload = {"circuits": {"Ma": {"voltage": 220.5}, "Bad": "not_a_dict"}}
    rows = _flatten_modbus(payload, FIXED_TS, "device-x")
    assert len(rows) == 1
    assert rows[0]["circuit_code"] == "Ma"


def test_flatten_modbus_circuits_skip_non_numeric_value():
    """circuits.params 內非 numeric 值 skip。"""
    payload = {"circuits": {"Ma": {"voltage": 220.5, "label": "ok"}}}
    rows = _flatten_modbus(payload, FIXED_TS, "device-x")
    assert len(rows) == 1
    assert rows[0]["parameter_code"] == "voltage"


# ===== _flatten_modbus 歷史扁平 (legacy fallback) =====

def test_flatten_modbus_legacy_flat_with_circuit_code():
    """歷史扁平 fallback：須有 circuit_code 才走（守門）。"""
    payload = {"voltage": 220.5, "active_power": 120.0, "circuit_code": "Ma"}
    rows = _flatten_modbus(payload, FIXED_TS, "device-x")
    assert len(rows) == 2
    by_pcode = {r["parameter_code"]: r["value"] for r in rows}
    assert by_pcode["voltage"] == 220.5
    assert by_pcode["active_power"] == 120.0


def test_flatten_modbus_legacy_flat_skip_meta_keys():
    """legacy flat：skip ts/timestamp/circuit_code 欄。"""
    payload = {
        "voltage": 220.5,
        "circuit_code": "Ma",
        "ts_ms": 1234567890,
        "ts": "2026-04-25",
        "timestamp": "2026-04-25",
    }
    rows = _flatten_modbus(payload, FIXED_TS, "device-x")
    assert len(rows) == 1  # 只有 voltage
    assert rows[0]["parameter_code"] == "voltage"


# ===== _flatten_modbus 守門 =====

def test_flatten_modbus_no_v2_no_circuit_code_returns_empty():
    """T-P12-009 守門：無 V2 fields 也無 circuit_code → 不誤判走 fallback；返回空。

    這是修 bug 的關鍵：原邏輯這種 case 會誤走 fallback；fix 後守門擋住。
    """
    payload = {"voltage": 220.5, "junk": "abc"}
    rows = _flatten_modbus(payload, FIXED_TS, "device-x")
    assert rows == []


def test_flatten_modbus_empty_payload():
    """空 payload → 空 rows。"""
    rows = _flatten_modbus({}, FIXED_TS, "device-x")
    assert rows == []


# ===== _flatten_ir =====

def test_flatten_ir_full_payload():
    """熱像 max/min/avg 全寫入；其他 key 忽略。"""
    payload = {"max_temp": 80.5, "min_temp": 20.0, "avg_temp": 50.2, "extra": "ignored"}
    rows = _flatten_ir(payload, FIXED_TS, "thermal-x")
    assert len(rows) == 3
    by_pcode = {r["parameter_code"]: r["value"] for r in rows}
    assert by_pcode["max_temp"] == 80.5
    assert by_pcode["min_temp"] == 20.0
    assert by_pcode["avg_temp"] == 50.2
    for r in rows:
        assert r["circuit_code"] == "_all"
        assert r["device_id"] == "thermal-x"


def test_flatten_ir_partial_payload():
    """熱像只有部分欄位也寫入 partial。"""
    payload = {"max_temp": 80.5}
    rows = _flatten_ir(payload, FIXED_TS, "thermal-x")
    assert len(rows) == 1
    assert rows[0]["parameter_code"] == "max_temp"


def test_flatten_ir_skip_non_numeric():
    """熱像欄位非 numeric 則 skip。"""
    payload = {"max_temp": "hot", "min_temp": 20.0}
    rows = _flatten_ir(payload, FIXED_TS, "thermal-x")
    assert len(rows) == 1
    assert rows[0]["parameter_code"] == "min_temp"
