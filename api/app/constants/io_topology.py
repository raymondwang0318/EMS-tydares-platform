"""IO topology constants (M-PM-245 §2.1 §4.5).

採證源：vault `01_Edge/遠端IO_腳位功能模板_TCS300B03_TCS300B04.md` v1.0

6 場域 × 4 device（TCS300B03 × 3 DI + TCS300B04 × 1 DO）= 24 device fleet
每場域 max 9 風扇（6 負壓 + 3 內循環）
每風扇 DI 4 ch（手動/自動/運轉/過載）+ DO 1 ch（自動起動）

⚠️ 業務命名（負壓風扇 1 手動 etc）per slave 不同，屬 admin-ui display layer（P11 frontend
或後續 ECSU display）；本 module 只放場域與 device_kind 對齊。
"""

from __future__ import annotations

from typing import TypedDict


class SiteDef(TypedDict):
    site_code: str       # Aa / Ab / Ae / Ba / Bc / C
    edge_id: str         # TYDARES-E17 ... E22
    site_name: str       # 業務命名（育成 Aa 等）


# 6 場域 → Edge mapping（採證 ems_edge.edge_name 'TYDARES-E17 = 育成-Aa' etc）
IO_SITES: list[SiteDef] = [
    {"site_code": "Aa", "edge_id": "TYDARES-E17", "site_name": "育成 Aa 區"},
    {"site_code": "Ab", "edge_id": "TYDARES-E18", "site_name": "育成 Ab 區"},
    {"site_code": "Ae", "edge_id": "TYDARES-E19", "site_name": "育成 Ae 區"},
    {"site_code": "Ba", "edge_id": "TYDARES-E20", "site_name": "育成 Ba 區"},
    {"site_code": "Bc", "edge_id": "TYDARES-E21", "site_name": "育成 Bc 區"},
    {"site_code": "C", "edge_id": "TYDARES-E22", "site_name": "育成 C 區"},
]

# Edge → site_code 反查 dict
EDGE_TO_SITE: dict[str, str] = {s["edge_id"]: s["site_code"] for s in IO_SITES}

# I/O device_kind set（採證 device_circuits.py + M-PM-242 §3.2）
IO_DEVICE_KINDS = {"tcs300b03_di", "tcs300b04_do"}

# 每場域風扇 template（max 9 = 6 負壓 + 3 內循環）
# 業務命名 P11E maintain；本 module 提供 default labels + per-fan DI ch + DO ch 對齊 vault SSOT §3.3-3.4
# vault SSOT §2.1 slave 1 = DI1-4 風扇1 / DI5-8 風扇2 / DI9-12 風扇3 / DI13-16 風扇4
# slave 2 = DI1-4 風扇5 / DI5-8 風扇6 / DI9-12 內循環1 / DI13-16 內循環2
# slave 3 = DI1-4 內循環3（+ DI5-16 預留）
# slave 4 (DO) = DO1 風扇1 / DO2 風扇2 / ... DO6 風扇6 / DO7 內循環1 / DO8 內循環2 / DO9 內循環3
FAN_TEMPLATE = [
    {"fan_id": "fan_np_1", "label": "負壓風扇 1", "category": "negative_pressure",
     "di_slave": 1, "di_channels": {"manual": 1, "auto": 2, "run": 3, "overload": 4},
     "do_slave": 4, "do_channel": 1},
    {"fan_id": "fan_np_2", "label": "負壓風扇 2", "category": "negative_pressure",
     "di_slave": 1, "di_channels": {"manual": 5, "auto": 6, "run": 7, "overload": 8},
     "do_slave": 4, "do_channel": 2},
    {"fan_id": "fan_np_3", "label": "負壓風扇 3", "category": "negative_pressure",
     "di_slave": 1, "di_channels": {"manual": 9, "auto": 10, "run": 11, "overload": 12},
     "do_slave": 4, "do_channel": 3},
    {"fan_id": "fan_np_4", "label": "負壓風扇 4", "category": "negative_pressure",
     "di_slave": 1, "di_channels": {"manual": 13, "auto": 14, "run": 15, "overload": 16},
     "do_slave": 4, "do_channel": 4},
    {"fan_id": "fan_np_5", "label": "負壓風扇 5", "category": "negative_pressure",
     "di_slave": 2, "di_channels": {"manual": 1, "auto": 2, "run": 3, "overload": 4},
     "do_slave": 4, "do_channel": 5},
    {"fan_id": "fan_np_6", "label": "負壓風扇 6", "category": "negative_pressure",
     "di_slave": 2, "di_channels": {"manual": 5, "auto": 6, "run": 7, "overload": 8},
     "do_slave": 4, "do_channel": 6},
    {"fan_id": "fan_cir_1", "label": "內循環風扇 1", "category": "circulation",
     "di_slave": 2, "di_channels": {"manual": 9, "auto": 10, "run": 11, "overload": 12},
     "do_slave": 4, "do_channel": 7},
    {"fan_id": "fan_cir_2", "label": "內循環風扇 2", "category": "circulation",
     "di_slave": 2, "di_channels": {"manual": 13, "auto": 14, "run": 15, "overload": 16},
     "do_slave": 4, "do_channel": 8},
    {"fan_id": "fan_cir_3", "label": "內循環風扇 3", "category": "circulation",
     "di_slave": 3, "di_channels": {"manual": 1, "auto": 2, "run": 3, "overload": 4},
     "do_slave": 4, "do_channel": 9},
]


def get_site(site_code: str) -> SiteDef | None:
    """Return SiteDef for given site_code, or None."""
    for s in IO_SITES:
        if s["site_code"] == site_code:
            return s
    return None


def list_sites() -> list[SiteDef]:
    """Return all 6 IO sites."""
    return list(IO_SITES)


def list_fans_template() -> list[dict]:
    """Return max-config fan template (9 fans per site)."""
    return [dict(f) for f in FAN_TEMPLATE]
