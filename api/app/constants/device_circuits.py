"""Device kind → circuit list mapping (schema-driven hardcode constants).

M-PM-228 採納業主明示『乙. Long-term schema-driven』；不擴 schema。
採證源：01_Edge/AEM-DRB-1_Modbus通訊表地圖.md / CPM-23_Modbus通訊表地圖.md /
        CPM-12D_Modbus通訊表地圖.md + trx_reading parameter_code prefix 對齊。

frontend ECSU 綁定 dialog 改 dropdown 後寫入 fnd_ecsu_circuit_assgn.circuit_code。

注意：DB trx_reading 真實 circuit_code 統一 'Ma'（driver 路徑）；本 module
為 ECSU 邏輯模型用，與 trx_reading 解耦（ECSU 綁定後聚合 query 由 backend 處理）。
"""

from __future__ import annotations

from typing import TypedDict


class CircuitDef(TypedDict):
    code: str       # circuit_code 寫入 fnd_ecsu_circuit_assgn
    name: str       # UI 顯示
    category: str   # 'main' | 'branch'


# AEM-DRB-1 多迴路電表（採證 01_Edge/AEM-DRB-1_Modbus通訊表地圖.md）
# - Ma/Mb 主迴路（0x1000 區 / Mb 結構同 Ma）
# - Ba1-12 分支（0x1400 區；ba1_i / ba1_p / ba1_pf / ba1_ae_imp 等）
# - Bb1-12 分支（0x1800 區）
# - 三相虛擬聚合（driver 內建 parameter_code: ba1_3_p_sum / ba4_6_p_sum / ... 8 條；M-PM-237 §2.3）
_AEM_DRB_CIRCUITS: list[CircuitDef] = [
    {"code": "ma", "name": "Ma 主迴路", "category": "main"},
    {"code": "mb", "name": "Mb 主迴路", "category": "main"},
    *[
        {"code": f"ba{i}", "name": f"Ba{i} 分支", "category": "branch"}
        for i in range(1, 13)
    ],
    *[
        {"code": f"bb{i}", "name": f"Bb{i} 分支", "category": "branch"}
        for i in range(1, 13)
    ],
    # 三相虛擬聚合（M-PM-237 §2.3 + driver 內建 ba1_3_p_sum 等預算 8 條）
    {"code": "ba1-3", "name": "Ba1-3 三相 A 組", "category": "three_phase"},
    {"code": "ba4-6", "name": "Ba4-6 三相 B 組", "category": "three_phase"},
    {"code": "ba7-9", "name": "Ba7-9 三相 C 組", "category": "three_phase"},
    {"code": "ba10-12", "name": "Ba10-12 三相 D 組", "category": "three_phase"},
    {"code": "bb1-3", "name": "Bb1-3 三相 A 組", "category": "three_phase"},
    {"code": "bb4-6", "name": "Bb4-6 三相 B 組", "category": "three_phase"},
    {"code": "bb7-9", "name": "Bb7-9 三相 C 組", "category": "three_phase"},
    {"code": "bb10-12", "name": "Bb10-12 三相 D 組", "category": "three_phase"},
]

# CPM-23 單一三相電表（採證 01_Edge/CPM-23_Modbus通訊表地圖.md）
# 摘要量測區 + 個別相位 + THD 都歸一個迴路
_CPM23_CIRCUITS: list[CircuitDef] = [
    {"code": "ma", "name": "主迴路", "category": "main"},
]

# CPM-12D 單一電表（採證 01_Edge/CPM-12D_Modbus通訊表地圖.md）
_CPM12D_CIRCUITS: list[CircuitDef] = [
    {"code": "ma", "name": "主迴路", "category": "main"},
]

# M-PM-242 §3.2: 遠端 I/O 模組（採證 01_Edge/遠端IO_腳位功能模板_TCS300B03_TCS300B04.md v1.0）
# TCS300B03 = 16 DI（每控制箱 × 3 顆 slave 1/2/3）
# TCS300B04 = 16 DO（每控制箱 × 1 顆 slave 4）
# channel name 對應風扇 manual/auto/run/overload signal（業主 5/19 4 張電路圖）
_TCS300B03_DI_CIRCUITS: list[CircuitDef] = [
    {"code": f"di_ch{i}", "name": f"DI {i}", "category": "digital_input"}
    for i in range(1, 17)
]

_TCS300B04_DO_CIRCUITS: list[CircuitDef] = [
    {"code": f"do_ch{i}", "name": f"DO {i}", "category": "digital_output"}
    for i in range(1, 17)
]


DEVICE_MODEL_CIRCUITS: dict[str, list[CircuitDef]] = {
    "aem_drb": _AEM_DRB_CIRCUITS,
    "cpm23": _CPM23_CIRCUITS,
    "cpm12d": _CPM12D_CIRCUITS,
    # M-PM-242 §3.2 遠端 I/O
    "tcs300b03_di": _TCS300B03_DI_CIRCUITS,
    "tcs300b04_do": _TCS300B04_DO_CIRCUITS,
}


def get_circuits(device_kind: str) -> list[CircuitDef] | None:
    """Return circuit list for given device_kind, or None if unknown.

    device_kind 字串對齊 driver code（採證 trx_reading device_id prefix）：
    cpm12d / cpm23 / aem_drb
    """
    return DEVICE_MODEL_CIRCUITS.get(device_kind)


def get_all_circuits() -> dict[str, list[CircuitDef]]:
    """Return all device_kind → circuit list mapping (級聯下拉 fallback)."""
    return dict(DEVICE_MODEL_CIRCUITS)


# ============================================================================
# M-PM-237 Phase B+C: ECSU binding circuit_code → trx_reading parameter_code mapping
# ============================================================================
# Phase A 採證鐵證：
# - trx_reading.circuit_code 統一 'Ma'（driver flat 寫；不分 ba1/ba2）
# - trx_reading.parameter_code 含個別迴路（ba1_p, ba1_i, ba1_ae_imp）+ driver 內建三相聚合
#   （ba1_3_p_sum / ba4_6_p_sum / ... 8 條 + ma_p_sum / mb_p_sum）
# - ECSU binding circuit_code='ba1' 對 trx_reading 找不到 row（root cause C）
# Phase B+C fix: backend mapping layer，bypass trx_reading.circuit_code，
#                直接從 a.circuit_code 計算 parameter_code 對齊 driver 真實 register


def _parse_device_kind(device_id: str) -> str:
    """device_id prefix → device_kind. e.g. 'aem_drb-TYDARES-E04-slave20' → 'aem_drb'.

    對齊 trx_reading device_id naming convention（worker.py L67 ingest pipeline）。
    """
    if device_id.startswith("aem_drb"):
        return "aem_drb"
    if device_id.startswith("cpm23"):
        return "cpm23"
    if device_id.startswith("cpm12d"):
        return "cpm12d"
    return "unknown"


def map_circuit_to_power_param(circuit_code: str, device_id: str) -> str:
    """ECSU binding circuit_code → trx_reading parameter_code for power (instantaneous kw).

    Examples:
        ('ma', 'aem_drb-...') → 'ma_p_sum'
        ('ba1', 'aem_drb-...') → 'ba1_p'
        ('ba1-3', 'aem_drb-...') → 'ba1_3_p_sum' (driver 內建三相聚合)
        ('ma', 'cpm23-...') → 'power_total'
    """
    kind = _parse_device_kind(device_id)
    cc = (circuit_code or "").lower()

    if kind in ("cpm23", "cpm12d"):
        return "power_total"

    if kind == "aem_drb":
        if cc in ("ma", "mb"):
            return f"{cc}_p_sum"
        # 三相虛擬聚合：'ba1-3' → 'ba1_3_p_sum'（driver 內建；M-PM-237 §2.3）
        if "-" in cc and cc[:2] in ("ba", "bb"):
            return cc.replace("-", "_") + "_p_sum"
        # 單一分支：'ba1' → 'ba1_p'
        if cc[:2] in ("ba", "bb"):
            return f"{cc}_p"

    return "power_total"  # fallback


def map_circuit_to_energy_param(circuit_code: str, device_id: str) -> str:
    """同上 for energy_kwh_imp (accumulated kWh; for monthly endpoint).

    Examples:
        ('ma', 'aem_drb-...') → 'ma_ae_imp'
        ('ba1', 'aem_drb-...') → 'ba1_ae_imp'
        ('ba1-3', 'aem_drb-...') → 'ba1_3_ae_imp'
        ('ma', 'cpm23-...') → 'energy_kwh_imp'
    """
    kind = _parse_device_kind(device_id)
    cc = (circuit_code or "").lower()

    if kind in ("cpm23", "cpm12d"):
        return "energy_kwh_imp"

    if kind == "aem_drb":
        if cc in ("ma", "mb"):
            return f"{cc}_ae_imp"
        if "-" in cc and cc[:2] in ("ba", "bb"):
            return cc.replace("-", "_") + "_ae_imp"
        if cc[:2] in ("ba", "bb"):
            return f"{cc}_ae_imp"

    return "energy_kwh_imp"  # fallback


# ============================================================================
# M-PM-264 §二: 5 metric mapping (voltage / freq / current / pf / demand)
# 老王 5/22 hard reload 覆寫 M-P11-E19 拍板 1：必須有數據 → AVG (不乘 sign).
# 採證源：trx_reading distinct parameter_code (M-PM-264 §一 採證 5/24);
# aem_drb branch (ba/bb) 無自身 voltage/freq/demand register → 繼承 main (ma/mb)；
# branch 自身有 _i (current) + _pf；三相聚合 (ba1_3 etc) 有 _i_avg + _pf_avg.
# ============================================================================


def _aem_branch_to_main(cc: str) -> str:
    """aem_drb branch circuit_code → 對應 main (ba* → ma / bb* → mb / 三相聚合同).

    用於 voltage / frequency / demand 等 branch 無 register 的 metric 繼承 main.
    """
    if cc.startswith("ba"):
        return "ma"
    if cc.startswith("bb"):
        return "mb"
    return cc  # ma / mb 自己 fallback


def map_circuit_to_voltage_param(circuit_code: str, device_id: str) -> str:
    """ECSU 平均電壓聚合用 parameter_code.

    cpm23 → 'voltage_ll_avg' (線間電壓平均;業主一般指 380V 系列)
    cpm12d → 'voltage_avg'
    aem_drb ma/mb/branch → 'ma_v_avg' / 'mb_v_avg' (branch 繼承 main)
    """
    kind = _parse_device_kind(device_id)
    cc = (circuit_code or "").lower()
    if kind == "cpm23":
        return "voltage_ll_avg"
    if kind == "cpm12d":
        return "voltage_avg"
    if kind == "aem_drb":
        main = _aem_branch_to_main(cc.split("-")[0] if "-" in cc else cc)
        return f"{main}_v_avg"
    return "voltage_avg"  # fallback


def map_circuit_to_frequency_param(circuit_code: str, device_id: str) -> str:
    """ECSU 平均頻率聚合用 parameter_code.

    cpm23/cpm12d → 'frequency'
    aem_drb ma/mb/branch → 'ma_freq' / 'mb_freq' (branch 繼承 main)
    """
    kind = _parse_device_kind(device_id)
    cc = (circuit_code or "").lower()
    if kind in ("cpm23", "cpm12d"):
        return "frequency"
    if kind == "aem_drb":
        main = _aem_branch_to_main(cc.split("-")[0] if "-" in cc else cc)
        return f"{main}_freq"
    return "frequency"  # fallback


def map_circuit_to_current_param(circuit_code: str, device_id: str) -> str:
    """ECSU 平均電流聚合用 parameter_code.

    cpm23/cpm12d → 'current_avg'
    aem_drb ma/mb → 'ma_i_avg' / 'mb_i_avg'
    aem_drb branch (ba1..ba12, bb1..bb12) → '{cc}_i' (per-branch)
    aem_drb 三相聚合 (ba1-3 etc) → '{cc_underscore}_i_avg'
    """
    kind = _parse_device_kind(device_id)
    cc = (circuit_code or "").lower()
    if kind in ("cpm23", "cpm12d"):
        return "current_avg"
    if kind == "aem_drb":
        if cc in ("ma", "mb"):
            return f"{cc}_i_avg"
        if "-" in cc and cc[:2] in ("ba", "bb"):
            return cc.replace("-", "_") + "_i_avg"
        if cc[:2] in ("ba", "bb"):
            return f"{cc}_i"
    return "current_avg"  # fallback


def map_circuit_to_pf_param(circuit_code: str, device_id: str) -> str:
    """ECSU 平均功率因數聚合用 parameter_code.

    cpm23/cpm12d → 'power_factor_avg'
    aem_drb ma/mb → 'ma_pf' / 'mb_pf'
    aem_drb branch → '{cc}_pf' (per-branch)
    aem_drb 三相聚合 → '{cc_underscore}_pf_avg'
    """
    kind = _parse_device_kind(device_id)
    cc = (circuit_code or "").lower()
    if kind in ("cpm23", "cpm12d"):
        return "power_factor_avg"
    if kind == "aem_drb":
        if cc in ("ma", "mb"):
            return f"{cc}_pf"
        if "-" in cc and cc[:2] in ("ba", "bb"):
            return cc.replace("-", "_") + "_pf_avg"
        if cc[:2] in ("ba", "bb"):
            return f"{cc}_pf"
    return "power_factor_avg"  # fallback


def map_circuit_to_demand_param(circuit_code: str, device_id: str) -> str:
    """ECSU 平均需量聚合用 parameter_code (W active power demand).

    cpm12d → 'demand_p_total'
    cpm23 → 'demand_p_sum'
    aem_drb ma/mb/branch → 'ma_p_dm' / 'mb_p_dm' (branch 繼承 main;register 無 per-branch demand)
    """
    kind = _parse_device_kind(device_id)
    cc = (circuit_code or "").lower()
    if kind == "cpm12d":
        return "demand_p_total"
    if kind == "cpm23":
        return "demand_p_sum"
    if kind == "aem_drb":
        main = _aem_branch_to_main(cc.split("-")[0] if "-" in cc else cc)
        return f"{main}_p_dm"
    return "demand_p_sum"  # fallback


# ============================================================================
# M-PM-264 §二: aggregation mode classification
# AVG metrics (不乘 sign;平均值無正負意義) vs SUM × sign metrics
# ============================================================================

# parameter_code → aggregation mode 'avg' or 'sum_sign'
# AVG mode: 對應 5 metric (voltage / freq / current / pf / demand)
# SUM × sign: 既有 power_total / energy_kwh_imp / ma_p_sum / ma_ae_imp / ... (M-P12-061 §3.2)


def classify_parameter_aggregation(parameter_code: str) -> str:
    """Return 'avg' for voltage/freq/current/pf/demand metrics; 'sum_sign' otherwise.

    M-PM-264 §二: ECSU 模式聚合 mode 區分 — AVG 不乘 sign / SUM × sign 既有不動.

    Patterns:
      - voltage:  'voltage*' / '*_v_avg'
      - freq:     'frequency' / '*_freq'
      - current:  'current*' / '*_i_avg' / branch '*_i' (ba1_i etc; not power _p)
                  → 用 '_i_avg' 結尾 + 'current' prefix + branch ba/bb 結尾 '_i' (非 _i_avg)
      - pf:       'power_factor*' / '*_pf' / '*_pf_avg' / '*_pf1'
      - demand:   'demand_*' / '*_p_dm'

    注意：branch '*_i' (e.g. 'ba1_i') 是 AVG；但 '*_i_avg_thd_r' 是 AVG (THD ratio);
    既有 'ma_p_sum' (power sum) 是 SUM × sign；'ba1_3_p_sum' 是 SUM × sign 不在此列.
    """
    pc = (parameter_code or "").lower()
    # AVG metrics
    if pc.startswith("voltage") or pc.endswith("_v_avg"):
        return "avg"
    if pc == "frequency" or pc.endswith("_freq"):
        return "avg"
    if pc.startswith("current"):
        return "avg"
    if pc.endswith("_i_avg") or pc.endswith("_i_avg_thd_r"):
        return "avg"
    # branch current: 'ba1_i', 'bb12_i' (single _i suffix, not _i_avg / _i_avg_thd_r)
    if (pc.startswith("ba") or pc.startswith("bb")) and pc.endswith("_i") and "_p_" not in pc:
        return "avg"
    if pc.startswith("power_factor") or pc.endswith("_pf") or pc.endswith("_pf_avg") or pc.endswith("_pf1"):
        return "avg"
    if pc.startswith("demand_") or pc.endswith("_p_dm"):
        return "avg"
    # default: SUM × sign (既有行為 power / energy / ...)
    return "sum_sign"
