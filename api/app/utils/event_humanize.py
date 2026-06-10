"""ems_events 訊息中文化（M-PM-318+S1 觀察點 7；老王 2026-06-10「你全包」）

老王明示：事件訊息除專有名詞外用中文說明紀錄，警報 mail 收件人才看得懂。

設計（方案 c 出口統一）：
  - 本模組為**單一中文字典 SSOT**（移植自 admin-ui utils/eventHumanize.ts，
    該前端版保留作顯示層雙保險；補翻譯請兩處同步）
  - 套用出口：mail_worker._build_body / v1_admin_events._event_row /
    v1_boss events row（出口翻譯，DB 保留原文；歷史英文事件亦涵蓋）
  - 冪等：已是中文的訊息不匹配英文 pattern，原樣通過
  - 未知樣式 fallback 原文（不破壞）
"""

from __future__ import annotations

import re

# event_kind → 繁中標籤
KIND_LABEL: dict[str, str] = {
    "command": "指令",
    "operation": "操作",
    "comm_abn": "通訊異常",
    "edge_lifecycle": "Edge 生命週期",
    "config_sync": "設定同步",
    "thermal_alarm": "熱像告警",
}

# severity → 繁中
SEV_LABEL: dict[str, str] = {
    "error": "錯誤",
    "critical": "嚴重",
    "fatal": "致命",
    "warn": "警告",
    "warning": "警告",
    "info": "資訊",
}

# 完全相符的固定訊息
_EXACT: dict[str, str] = {
    "approved": "已核可",
    "delivered to edge": "已派送至 Edge",
    "device soft-deleted": "設備已軟刪除",
    "device updated": "設備已更新",
    "ecsu deleted": "ECSU 已刪除",
    "entered maintenance": "進入維護模式",
    "placeholder device created (wizard bootstrap)": "已建立佔位設備（Wizard 初始化）",
    "resumed from maintenance": "已從維護模式恢復",
    "token issued after approval": "核可後已發出 token",
    "token re-issued (Edge re-enroll with matching fingerprint)":
        "token 已重發（Edge re-enroll，fingerprint 相符）",
    "edge hostname renamed": "Edge hostname 已更名",
    "already resolved": "已解除（先前已標記）",
    "resolved": "已解除",
}

# regex 樣式（pattern, 繁中模板）；\1 等取 group
_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"^command created: (.+)$"), r"已建立指令：\1"),
    (re.compile(r"^config ack: (\S+) v(\d+)$"), r"設定回報：\1 v\2"),
    (re.compile(r"^device created: (.+)$"), r"已建立設備：\1"),
    (re.compile(r"^revoked: (.*)$"), r"已撤銷：\1"),
    (re.compile(r"^enroll request status=(.+)$"), r"註冊請求 status=\1"),
    (re.compile(r"^batch cleanup placeholders: deleted (\d+) row\(s\)$"),
     r"批次清理佔位設備：已刪除 \1 筆"),
    (re.compile(r"^IR device archived[^:]*:\s*(.+)$"),
     r"IR 設備已封存（拆除設備列表隱藏）：\1"),
]

# 前綴替換（保留後段專有名詞）
_PREFIXES: list[tuple[str, str]] = [
    ("ecsu circuit bound:", "ECSU 迴路已綁定："),
    ("ecsu circuit unbound:", "ECSU 迴路已解綁："),
    ("ecsu circuit updated:", "ECSU 迴路已更新："),
    ("ecsu updated:", "ECSU 已更新："),
    ("edge updated:", "Edge 已更新："),
]

_REPORT_RE = re.compile(r"^report: (\S+)(?: err=(.+))?$")
_TRIGGERED_RE = re.compile(r"^(.+) triggered$")


def humanize_message(msg: str | None) -> str:
    """ems_events.message → 繁中描述（保留專有名詞）；未知樣式回原文。"""
    if not msg:
        return "—"
    if msg in _EXACT:
        return _EXACT[msg]

    m = _REPORT_RE.match(msg)
    if m:
        return f"指令回報：{m.group(1)}" + (f"，錯誤={m.group(2)}" if m.group(2) else "")

    for pat, tmpl in _PATTERNS:
        if pat.match(msg):
            return pat.sub(tmpl, msg)

    for prefix, zh in _PREFIXES:
        if msg.startswith(prefix):
            return zh + msg[len(prefix):].lstrip()

    m = _TRIGGERED_RE.match(msg)
    if m:
        return f"{m.group(1)} 觸發"

    return msg  # 未知樣式：保留原文（含已是中文者）


def sev_label(sev: str | None) -> str:
    if not sev:
        return "—"
    return SEV_LABEL.get(sev.lower(), sev)


def kind_label(kind: str | None) -> str:
    if not kind:
        return "—"
    return KIND_LABEL.get(kind, kind)
