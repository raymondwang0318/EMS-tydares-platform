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


DEVICE_MODEL_CIRCUITS: dict[str, list[CircuitDef]] = {
    "aem_drb": _AEM_DRB_CIRCUITS,
    "cpm23": _CPM23_CIRCUITS,
    "cpm12d": _CPM12D_CIRCUITS,
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
