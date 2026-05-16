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
