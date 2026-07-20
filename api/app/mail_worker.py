"""異常通知 Mail Worker（M-PM-313 + M-PM-B1 聚合）.

對 notify_pananora=TRUE 且未解除（resolved_at IS NULL）的事件發 mail，採「升級降頻」：
  第 1 次：立即（觸發即發）
  第 2 次起：距上次 24 小時（固定）
  （老王 2026-06-30：取消 4H/12H 中間階段，避免太頻繁）
事件被解除（resolved_at 填）後即停止重發。

全域異常總覽（M-P11-E109，2026-06-30）：
  所有未解除異常匯整一封 → 總服務信箱（tydaresems@gmail.com），獨立全域降頻
  （第一時間 → 之後每 24h），異常全部解除後重置計數。與聯絡人聚合信完全獨立。

聚合策略（M-PM-B1 2026-06-24 定案 + M-P11-E102 銜接）：
  同一聯絡人（data_json.alarm_recipient_id）→ 聚合為一封信（防洗版）。
  老王明示：不分事件類型，只要同聯絡人就合併。
  時間窗（AGGREGATE_WINDOW_SEC=600，2× tick）用於界定「同一批」回看邊界 +
  內文時段標示；不用於 SQL 撈取過濾（避免漏發 ts 較舊的重發事件）。
  逐事件更新降頻計數，聚合信件以最新時戳為準。

聯絡人來源（M-P11-E102 commit ab61ab6）：
  前台 alarm_evaluator 在 event data_json 帶 alarm_recipient_id + alarm_recipient_email。
  - 有聯絡人 → 按 alarm_recipient_id group → 發 alarm_recipient_email。
  - 無聯絡人（broadcast，alarm_recipient_id 空）→ 發 BROADCAST_FALLBACK_EMAIL
    （M-PM-B1 未明確 broadcast 端發給誰，待 PM 拍板；測試期暫用測試信箱）。

部署：ems-worker 單實例 asyncio task（同 alarm_evaluator pattern）。
smtplib 為阻塞 IO → 在 thread 執行（asyncio.to_thread）。
"""

from __future__ import annotations

import asyncio
import json
import logging
import smtplib
from datetime import datetime, timedelta, timezone
from email.mime.text import MIMEText
from email.utils import formataddr

from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.config import settings
from app.utils.event_humanize import humanize_message, sev_label

log = logging.getLogger("mail_worker")

SCAN_SEC = 300.0  # 5 分鐘掃一次
# 發送間隔（秒）；key = 已發送次數(mail_send_count)
# 老王 2026-06-30：取消 4H/12H 中間階段 → 第一時間發、之後固定 24H
INTERVALS = {0: 0}
DEFAULT_INTERVAL = 24 * 3600  # 第 2 次起固定 24H
AGGREGATE_WINDOW_SEC = 600  # 聚合回看窗（2× tick，涵蓋跨 tick 邊緣；M-P11-E102 銜接）

# 全域異常總覽（M-P11-E109）→ 總服務信箱，獨立降頻；同取消 4H/12H（老王 6/30）
INTERVALS_ARCHIVE = {0: 0}  # 第一時間發
DEFAULT_ARCHIVE_INTERVAL = 24 * 3600  # 之後固定 24H

# 總服務信箱（老王設立 tydaresems@gmail.com）：
# ① broadcast（無聯絡人）異常 fallback ② 全域異常總覽（M-P11-E109）收件。
# M-P11-E110 定位：日常 = 總服務信箱（收全廠異常總覽）；broadcast fallback 因
# default_recipient=姜禮成兜底已罕觸發（極端才用）。
BROADCAST_FALLBACK_EMAIL = "tydaresems@gmail.com"
ARCHIVE_EMAIL = BROADCAST_FALLBACK_EMAIL  # 全域異常總覽收件（M-P11-E109）

# 聚合信強化版（老王 2026-06-24：全匯一服務窗口→可讀性=唯一防線）
SEV_RANK = {"critical": 0, "warn": 1}  # 排序：critical 先
SEV_EMOJI = {"critical": "🔴", "warn": "⚠️"}
TW_TZ = timezone(timedelta(hours=8))  # 台灣時間（聚合信時段顯示）

_smtp_warned = False  # 只警告一次「SMTP 未設定」


def _smtp_configured() -> bool:
    return bool(settings.smtp_host)


def _parse_data_json(raw) -> dict:
    """容錯解析 ems_events.data_json（可能是 str / dict / None）。"""
    if raw is None:
        return {}
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, dict) else {}
        except (ValueError, TypeError):
            return {}
    return {}


def _send_mail_blocking(subject: str, body: str, recipients: list[str]) -> None:
    """阻塞式 SMTP 發送（在 thread 跑）。失敗 raise → 由 caller 捕捉。"""
    msg = MIMEText(body, "plain", "utf-8")
    msg["Subject"] = subject
    msg["From"] = formataddr(("Tydares EMS", settings.mail_from or settings.smtp_user))
    msg["To"] = ", ".join(recipients)

    with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=20) as s:
        if settings.smtp_tls:
            s.starttls()
        if settings.smtp_user:
            s.login(settings.smtp_user, settings.smtp_password)
        s.sendmail(settings.mail_from or settings.smtp_user, recipients, msg.as_string())


def _build_body(ev: dict) -> str:
    """單事件郵件（向後相容）。"""
    data = _parse_data_json(ev.get("data_json"))
    lines = [
        f"嚴重度：{sev_label(ev['severity'])}",
        f"迴路：{_ecsu_code(ev, data)}",  # ecsu_code(KW-xx)，非 device_id
        f"訊息：{humanize_message(ev['message']) if ev['message'] else '-'}",
        f"事件時間：{_fmt_ts_tw(ev['ts'])}",
        f"事件編號：#{ev['event_id']}",
    ]
    lines.append("")
    lines.append("（此為 Tydares EMS 自動通知；異常解除後將停止重發。）")
    return "\n".join(lines)


def _fmt_ts_tw(ts) -> str:
    """UTC datetime → 台灣時間 HH:MM:SS。"""
    if not ts:
        return "-"
    try:
        return ts.astimezone(TW_TZ).strftime("%H:%M:%S")
    except (ValueError, AttributeError):
        return "-"


def _ecsu_code(ev: dict, data: dict) -> str:
    """迴路代號顯示：優先 data_json.ecsu_code(KW-xx)，fallback device_id。
    device_id 是 Edge 設備 ID(aem_drb-TYDARES-E21-slave100)，老王要看的是 ecsu_code(KW-100)。"""
    return data.get("ecsu_code") or ev.get("device_id") or "-"


def _extract_ecsu_name(ev: dict, data: dict) -> str:
    """取迴路名稱：優先 data_json.ecsu_name，fallback 從 message 解析。"""
    name = data.get("ecsu_name")
    if name:
        return str(name)
    # 前台 message 格式："{emoji} {code} {name} 電流偏高 — ..."（code=ecsu_code KW-xx）
    msg = ev.get("message") or ""
    code = data.get("ecsu_code") or ev.get("device_id") or ""
    if "電流偏高" in msg and code and code in msg:
        head = msg.split("電流偏高")[0]
        return head.split(code, 1)[1].strip() if code in head else ""
    return ""


def _build_aggregated_body(events: list[dict], recipient_label: str | None = None) -> str:
    """聚合多事件郵件（M-PM-B1 + M-P11-E102 + 老王強化版：摘要+排序+負載率）。

    全匯一個服務窗口信箱（老王 2026-06-24）→ 一封信可能含多迴路，
    可讀性=唯一防線：摘要統計 + 按嚴重度/負載率排序（最危急在最上）+ 結構化負載顯示。
    """
    # 解析每個事件：負載率（排序+顯示）、嚴重度、名稱、電流/安全值
    enriched = []
    for ev in events:
        data = _parse_data_json(ev.get("data_json"))
        try:
            ratio = float(data.get("ratio_pct") or 0)
        except (ValueError, TypeError):
            ratio = 0.0
        enriched.append({
            "ev": ev,
            "sev": ev.get("severity"),
            "ratio": ratio,
            "code": _ecsu_code(ev, data),
            "name": _extract_ecsu_name(ev, data),
            "cur": data.get("current_a"),
            "safe": data.get("safe_current"),
        })

    # 排序：critical 先，同級按負載率降序（最危急在最上）
    enriched.sort(key=lambda e: (SEV_RANK.get(e["sev"], 9), -e["ratio"]))

    # 摘要統計
    n_crit = sum(1 for e in enriched if e["sev"] == "critical")
    n_warn = sum(1 for e in enriched if e["sev"] == "warn")
    parts = []
    if n_crit:
        parts.append(f"🔴危急 {n_crit}")
    if n_warn:
        parts.append(f"⚠️警戒 {n_warn}")
    summary = f"（共 {len(enriched)} 筆" + (" — " + "、".join(parts) if parts else "") + "）"

    # 聚合時段（台灣時間）
    ts_list = [e["ev"].get("ts") for e in enriched if e["ev"].get("ts")]
    if ts_list:
        t_min, t_max = _fmt_ts_tw(min(ts_list)), _fmt_ts_tw(max(ts_list))
        span = f"{t_min} ~ {t_max}" if t_min != t_max else t_min
    else:
        span = "-"

    lines = [f"本批異常迴路聚合{summary}", f"聚合時段：{span}"]
    if recipient_label:
        lines.append(f"收件：{recipient_label}")
    lines.append("")

    # 逐迴路（已排序，最危急在最上）
    for e in enriched:
        ev = e["ev"]
        code = e["code"]  # ecsu_code(KW-xx)，非 device_id
        emoji = SEV_EMOJI.get(e["sev"], "•")
        if e["ratio"] and e["ratio"] > 0:
            cur_s = f"{float(e['cur']):.1f}A" if e["cur"] is not None else "-"
            safe_s = f"{float(e['safe']):.0f}A" if e["safe"] is not None else "-"
            name_s = f" {e['name']}" if e["name"] else ""
            lines.append(f"{emoji} {code}{name_s} — 負載 {e['ratio']:.0f}%（{cur_s} / 安全 {safe_s}）")
        else:
            # 非電流告警（如電力中斷）→ 白話 message
            msg = ev.get("message") or "-"
            if "｜通知" in msg:
                msg = msg.split("｜通知")[0].strip()
            lines.append(f"{emoji} {msg}")

    # 建議：點出負載最高者
    top = max((e for e in enriched if e["ratio"] > 0), key=lambda x: x["ratio"], default=None)
    lines.append("")
    if top:
        lines.append(f"建議：優先處理負載最高者（{top['code']} {top['ratio']:.0f}%）")
    else:
        lines.append("建議：檢查迴路負載分布")
    lines.append("（異常解除後停止重發）")
    return "\n".join(lines)


def _build_archive_overview(events: list[dict], now: datetime) -> str:
    """全域異常總覽內文（M-P11-E109）：所有未解除異常白話列出、按嚴重度排序。"""
    n = len(events)
    n_crit = sum(1 for e in events if e.get("severity") == "critical")
    n_warn = sum(1 for e in events if e.get("severity") == "warn")
    parts = []
    if n_crit:
        parts.append(f"🔴危急 {n_crit}")
    if n_warn:
        parts.append(f"⚠️警戒 {n_warn}")
    summary = f"（共 {n} 筆" + (" — " + "、".join(parts) if parts else "") + "）"
    lines = [f"全廠異常總覽{summary}", f"產生時間：{_fmt_ts_tw(now)}", ""]
    for ev in sorted(events, key=lambda e: SEV_RANK.get(e.get("severity"), 9)):
        data = _parse_data_json(ev.get("data_json"))
        code = _ecsu_code(ev, data)
        name = _extract_ecsu_name(ev, data)
        name_s = f" {name}" if name else ""
        emoji = "🌡️" if ev.get("event_kind") == "thermal_alarm" else SEV_EMOJI.get(ev.get("severity"), "•")
        try:
            ratio = float(data.get("ratio_pct") or 0)
        except (ValueError, TypeError):
            ratio = 0.0
        if ratio > 0:
            lines.append(f"{emoji} {code}{name_s} — 負載 {ratio:.0f}%")
        else:
            msg = ev.get("message") or "-"
            if "｜通知" in msg:
                msg = msg.split("｜通知")[0].strip()
            lines.append(f"{emoji} {msg}")
    lines.append("")
    lines.append("（全廠異常總覽；異常全部解除後重置。降頻：第一時間 → 之後每 24 小時）")
    return "\n".join(lines)


async def _archive_overview(db, now: datetime, events: list) -> None:
    """全域異常總覽 → 總服務信箱（M-P11-E109，2026-06-30）。

    所有未解除異常匯整一封、獨立全域降頻（第一時間→24h）、異常全清重置計數。
    與聯絡人聚合信完全獨立（聯絡人照收自己迴路；此處額外發全廠總覽到總服務信箱）。
    """
    row = (await db.execute(text(
        "SELECT last_sent_at, sent_count FROM ems_mail_archive_state WHERE id = 1"
    ))).mappings().first()
    last_sent = row["last_sent_at"] if row else None
    sent_count = (row["sent_count"] if row else 0) or 0

    # 無未解除異常 → 重置計數（下次新異常重新第一時間發）
    if not events:
        if sent_count != 0:
            await db.execute(text("UPDATE ems_mail_archive_state SET sent_count = 0 WHERE id = 1"))
            await db.commit()
            log.info("mail_worker archive: 無未解除異常 → 重置計數")
        return

    # 全域降頻（獨立於個別聯絡人降頻）
    interval = INTERVALS_ARCHIVE.get(sent_count, DEFAULT_ARCHIVE_INTERVAL)
    if last_sent is not None and (now - last_sent).total_seconds() < interval:
        return  # 降頻未到

    subject = f"[Tydares EMS 異常總覽] 目前 {len(events)} 筆異常"
    body = _build_archive_overview([dict(e) for e in events], now)
    try:
        await asyncio.to_thread(_send_mail_blocking, subject, body, [ARCHIVE_EMAIL])
    except Exception as e:
        log.warning("mail_worker archive 發送失敗: %s", e)
        return

    await db.execute(text("""
        INSERT INTO ems_mail_archive_state (id, last_sent_at, sent_count)
        VALUES (1, NOW(), 1)
        ON CONFLICT (id) DO UPDATE
        SET last_sent_at = NOW(), sent_count = ems_mail_archive_state.sent_count + 1
    """))
    await db.commit()
    log.info("mail_worker archive: 全廠總覽發送 %s（%d 筆異常，第 %d 次）",
             ARCHIVE_EMAIL, len(events), sent_count + 1)


def _build_resolve_body(events: list[dict], recipient_label: str | None = None) -> str:
    """恢復通知內文（M-P11-E117）：曾發過信的異常 resolve 時白話「✅ 已恢復」。"""
    lines = [f"以下異常已恢復（共 {len(events)} 筆）："]
    if recipient_label:
        lines.append(f"收件：{recipient_label}")
    lines.append("")
    for ev in sorted(events, key=lambda e: e.get("resolved_at") or e.get("ts") or ""):
        data = _parse_data_json(ev.get("data_json"))
        ts_tw = _fmt_ts_tw(ev.get("resolved_at"))
        if data.get("kind") == "edge_outage":
            eid = data.get("edge_id") or ev.get("edge_id") or "-"
            ncirc = len(data.get("circuits") or [])
            lines.append(f"✅ {eid} 通訊已恢復（{ncirc} 個迴路恢復資料回報，{ts_tw}）")
        else:
            code = _ecsu_code(ev, data)
            name = _extract_ecsu_name(ev, data)
            name_s = f" {name}" if name else ""
            lines.append(f"✅ {code}{name_s} 已恢復（{ts_tw}）")
    lines.append("")
    lines.append("（此為 Tydares EMS 恢復通知，對應先前的異常告警。）")
    return "\n".join(lines)


async def _resolve_notify(db, now: datetime, thermal_emails: list, edge_outage_emails: list) -> None:
    """恢復通知（M-P11-E117，老王 2026-07-03 拍板「恢復也要發信」）。

    範圍：曾發過信（mail_send_count>0）且已 resolve 未發恢復通知的 event。
    收件人與原告警相同（thermal / edge_outage / alarm_recipient_id / broadcast→tydaresems，誰收異常誰收恢復）。
    沿用聚合分組（同收件人多筆恢復→一封防洗版），發完標 resolve_mail_sent_at 防重發。
    全告警類型統一（電流/中斷/溫度/edge_outage）。
    """
    rows = (await db.execute(text("""
        SELECT event_id, ts, severity, source, edge_id, device_id, message, data_json,
               event_kind, resolved_at
        FROM ems_events
        WHERE resolved_at IS NOT NULL AND mail_send_count > 0 AND resolve_mail_sent_at IS NULL
        ORDER BY resolved_at ASC
    """))).mappings().all()
    if not rows:
        return

    # 分組（收件人邏輯對齊 tick：thermal / edge_outage / id / email / broadcast）
    groups: dict[str, dict] = {}
    for ev in rows:
        if ev["event_kind"] == "thermal_alarm":
            emails = thermal_emails or [BROADCAST_FALLBACK_EMAIL]
            g = groups.setdefault("__thermal__", {"emails": emails, "label": "溫度告警收件人", "events": []})
            g["events"].append(ev)
            continue
        data = _parse_data_json(ev["data_json"])
        if data.get("kind") == "edge_outage":
            emails = edge_outage_emails or [BROADCAST_FALLBACK_EMAIL]
            g = groups.setdefault("__edge_outage__", {"emails": emails, "label": "電表失聯通知人", "events": []})
            g["events"].append(ev)
            continue
        rid = data.get("alarm_recipient_id")
        remail = data.get("alarm_recipient_email")
        rname = data.get("alarm_recipient")
        if rid not in (None, "", 0):
            key, email = f"id:{rid}", (remail or BROADCAST_FALLBACK_EMAIL)
        elif remail:
            key, email = f"email:{remail}", remail
        else:
            key, email = "__broadcast__", BROADCAST_FALLBACK_EMAIL
        g = groups.setdefault(key, {"emails": [email], "label": rname, "events": []})
        g["events"].append(ev)

    sent = []
    for key, g in groups.items():
        subject = f"[Tydares EMS 恢復通知] {len(g['events'])} 筆異常已恢復"
        body = _build_resolve_body([dict(e) for e in g["events"]], recipient_label=g["label"])
        try:
            await asyncio.to_thread(_send_mail_blocking, subject, body, g["emails"])
        except Exception as e:
            log.warning("mail_worker resolve to %s (group=%s) failed: %s", g["emails"], key, e)
            continue  # 不標記 → 下次重試
        for ev in g["events"]:
            await db.execute(text(
                "UPDATE ems_events SET resolve_mail_sent_at = NOW() WHERE event_id = :id"
            ), {"id": ev["event_id"]})
            sent.append(ev["event_id"])
        log.info("mail_worker resolve: sent to %s (group=%s) with %d event(s)",
                 g["emails"], key, len(g["events"]))
    if sent:
        await db.commit()
        log.info("mail_worker tick (恢復通知): sent %d event(s)", len(sent))


async def mail_worker_tick(session_factory: async_sessionmaker) -> None:
    global _smtp_warned
    log.info("mail_worker tick: starting scan")
    if not _smtp_configured():
        if not _smtp_warned:
            log.warning("SMTP 未設定（SMTP_HOST 空）→ Mail Worker 略過發送；待老王設 .env")
            _smtp_warned = True
        return

    now = datetime.now(timezone.utc)
    async with session_factory() as db:
        # 全撈 pending（不限 ts，避免漏發 ts 較舊但該重發的事件）
        events = (await db.execute(text("""
            SELECT event_id, ts, severity, source, device_id, message, data_json,
                   event_kind, mail_send_count, last_mail_sent_at
            FROM ems_events
            WHERE notify_pananora = TRUE AND resolved_at IS NULL
            ORDER BY ts ASC
        """))).mappings().all()
        log.info("mail_worker tick: found %d pending events to process", len(events))

        # 溫度告警收件人（M-P11-E103：獨立一份，source='thermal'）
        thermal_emails = [r["email"] for r in (await db.execute(text("""
            SELECT email FROM ems_mail_recipient
            WHERE source = 'thermal' AND notify_enabled = TRUE
            ORDER BY recipient_id
        """))).mappings().all()]

        # 電表失聯（edge_outage）收件人（老王 2026-07-03：姜禮城/閻華/吳德偉，source='edge_outage'）
        edge_outage_emails = [r["email"] for r in (await db.execute(text("""
            SELECT email FROM ems_mail_recipient
            WHERE source = 'edge_outage' AND notify_enabled = TRUE
            ORDER BY recipient_id
        """))).mappings().all()]

        # 聚合：同聯絡人（alarm_recipient_id）→ 一封信（M-PM-B1 + M-P11-E102）
        # thermal_alarm → source='thermal' 清單（M-P11-E103）
        # group_key → {"emails": [收件地址], "label": 顯示名, "events": [...]}
        groups: dict[str, dict] = {}

        for ev in events:
            # 降頻檢查
            count = ev["mail_send_count"] or 0
            interval = INTERVALS.get(count, DEFAULT_INTERVAL)
            ref = ev["last_mail_sent_at"] or ev["ts"]
            elapsed = (now - ref).total_seconds()
            if elapsed < interval:
                continue

            # 溫度告警：獨立一份收件人（M-P11-E103），與電流分流
            if ev["event_kind"] == "thermal_alarm":
                if thermal_emails:
                    emails = thermal_emails
                else:
                    emails = [BROADCAST_FALLBACK_EMAIL]
                    log.warning("event_id=%s thermal_alarm 但無 thermal 收件人（source='thermal' 空）→ fallback %s",
                                ev["event_id"], BROADCAST_FALLBACK_EMAIL)
                g = groups.setdefault("__thermal__", {"emails": emails, "label": "溫度告警收件人", "events": []})
                g["events"].append(ev)
                continue

            # 電流/電力：從 data_json 取聯絡人（M-P11-E102 commit ab61ab6 前台已帶）
            data = _parse_data_json(ev["data_json"])

            # 電表失聯（data_json.kind='edge_outage'）：獨立收件人清單，與電流/溫度分流
            if data.get("kind") == "edge_outage":
                if edge_outage_emails:
                    emails = edge_outage_emails
                else:
                    emails = [BROADCAST_FALLBACK_EMAIL]
                    log.warning("event_id=%s edge_outage 但無收件人（source='edge_outage' 空）→ fallback %s",
                                ev["event_id"], BROADCAST_FALLBACK_EMAIL)
                g = groups.setdefault("__edge_outage__", {"emails": emails, "label": "電表失聯通知人", "events": []})
                g["events"].append(ev)
                continue

            recipient_id = data.get("alarm_recipient_id")
            recipient_email = data.get("alarm_recipient_email")
            recipient_name = data.get("alarm_recipient")  # 前台 description or email（label 用）

            # 決定聚合 key + 收件地址
            if recipient_id not in (None, "", 0):
                # 有指定聯絡人：用 id 聚合（穩健，防 email 變更分散）
                group_key = f"id:{recipient_id}"
                email = recipient_email or BROADCAST_FALLBACK_EMAIL
                if not recipient_email:
                    log.warning("event_id=%s recipient_id=%s 無 email，fallback %s",
                                ev["event_id"], recipient_id, BROADCAST_FALLBACK_EMAIL)
            elif recipient_email:
                # 無 id 但有 email（少見）：用 email 聚合
                group_key = f"email:{recipient_email}"
                email = recipient_email
            else:
                # broadcast（無聯絡人）：併入 broadcast 組，發 fallback
                group_key = "__broadcast__"
                email = BROADCAST_FALLBACK_EMAIL

            g = groups.setdefault(group_key, {"emails": [email], "label": recipient_name, "events": []})
            g["events"].append(ev)

        # 逐組發聚合信
        sent_events = []
        for group_key, g in groups.items():
            grouped_events = g["events"]
            emails = g["emails"]
            label = g["label"]
            is_thermal = group_key == "__thermal__"
            is_edge_outage = group_key == "__edge_outage__"

            if is_thermal:
                subject = f"[Tydares EMS 溫度告警] {len(grouped_events)} 筆設備過溫"
                body = _build_aggregated_body([dict(e) for e in grouped_events], recipient_label=label)
            elif is_edge_outage:
                subject = f"[Tydares EMS 電表失聯] {len(grouped_events)} 區通訊中斷"
                body = _build_aggregated_body([dict(e) for e in grouped_events], recipient_label=label)
            elif len(grouped_events) == 1:
                ev = grouped_events[0]
                subject = f"[Tydares EMS 告警] {sev_label(ev['severity'])} {ev['device_id'] or ''}".strip()
                body = _build_body(dict(ev))
            else:
                subject = f"[Tydares EMS 告警聚合] 多迴路異常 ({len(grouped_events)} 筆)"
                body = _build_aggregated_body([dict(e) for e in grouped_events], recipient_label=label)

            try:
                await asyncio.to_thread(_send_mail_blocking, subject, body, emails)
            except Exception as e:
                log.warning("mail send to %s (group=%s) failed: %s", emails, group_key, e)
                continue  # 不更新 → 下次 scan 重試

            # 更新聚合內所有事件的降頻計數
            for ev in grouped_events:
                await db.execute(text("""
                    UPDATE ems_events
                    SET last_mail_sent_at = NOW(),
                        mail_send_count = mail_send_count + 1,
                        mail_sent_at = COALESCE(mail_sent_at, NOW())
                    WHERE event_id = :id
                """), {"id": ev["event_id"]})
                sent_events.append(ev["event_id"])

            log.info("mail_worker: sent to %s (group=%s) with %d event(s)",
                     emails, group_key, len(grouped_events))

        if sent_events:
            await db.commit()
            log.info("mail_worker tick (聚合): sent to %d group(s), total events=%d",
                     len(groups), len(sent_events))

        # 全域異常總覽 → 總服務信箱（M-P11-E109）；獨立全域降頻，與聯絡人聚合信不互擾。
        # events = 全部未解除異常（不受個別降頻影響，archive 自有降頻 + 無異常重置）。
        await _archive_overview(db, now, events)

        # 恢復通知（M-P11-E117）：曾發過信的 event resolve 時通知一次「✅ 已恢復」，收件人同原告警。
        await _resolve_notify(db, now, thermal_emails, edge_outage_emails)


async def mail_worker_loop(session_factory: async_sessionmaker) -> None:
    log.info("mail_worker_loop started (scan=%ss intervals=0/24h; M-PM-313+B1+E109 總覽+E117 恢復通知)", SCAN_SEC)
    while True:
        try:
            await mail_worker_tick(session_factory)
        except Exception as e:  # pragma: no cover
            log.exception("mail_worker tick failed: %s", e)
        await asyncio.sleep(SCAN_SEC)
