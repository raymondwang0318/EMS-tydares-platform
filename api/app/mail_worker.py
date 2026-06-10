"""異常通知 Mail Worker（M-PM-313 階段2 P3）.

對 notify_pananora=TRUE 且未解除（resolved_at IS NULL）的事件發 mail，採「升級降頻」：
  第 1 次：立即（觸發即發）
  第 2 次：距上次 4 小時
  第 3 次：距上次 12 小時
  第 4 次起：距上次 24 小時（固定）
事件被解除（resolved_at 填）後即停止重發。

統一發送（M-PM-313 §3.5 PM 推薦 b）：發給「全部 notify_enabled 收件人」，不分 source。
全天候（無靜默時段）。SMTP 由 .env 注入（老王階段2 設）；未設 → 本 worker 略過發送（不報錯）。

部署：ems-worker 單實例 asyncio task（同 alarm_evaluator pattern）。
smtplib 為阻塞 IO → 在 thread 執行（asyncio.to_thread）。
"""

from __future__ import annotations

import asyncio
import logging
import smtplib
from datetime import datetime, timezone
from email.mime.text import MIMEText
from email.utils import formataddr

from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.config import settings
from app.utils.event_humanize import humanize_message, sev_label

log = logging.getLogger("mail_worker")

SCAN_SEC = 300.0  # 5 分鐘掃一次
# 第 1/2/3/4+ 次發送間隔（秒）；key = 已發送次數(mail_send_count)
INTERVALS = {0: 0, 1: 4 * 3600, 2: 12 * 3600, 3: 24 * 3600}
DEFAULT_INTERVAL = 24 * 3600  # 第 4 次起固定 24H

_smtp_warned = False  # 只警告一次「SMTP 未設定」


def _smtp_configured() -> bool:
    return bool(settings.smtp_host)


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
    # M-PM-318+S1 觀察點7（老王 2026-06-10）：mail 內容中文化，收件人免苦惱英文
    lines = [
        f"嚴重度：{sev_label(ev['severity'])}",
        f"來源：{ev['source']}",
        f"設備：{ev['device_id'] or '-'}",
        f"訊息：{humanize_message(ev['message']) if ev['message'] else '-'}",
        f"事件時間：{ev['ts'].isoformat() if ev['ts'] else '-'}",
        f"事件編號：#{ev['event_id']}",
    ]
    if ev.get("data_json"):
        lines.append(f"詳情：{ev['data_json']}")
    lines.append("")
    lines.append("（此為 Tydares EMS 自動通知；異常解除後將停止重發。）")
    return "\n".join(lines)


async def mail_worker_tick(session_factory: async_sessionmaker) -> None:
    global _smtp_warned
    if not _smtp_configured():
        if not _smtp_warned:
            log.warning("SMTP 未設定（SMTP_HOST 空）→ Mail Worker 略過發送；待老王設 .env")
            _smtp_warned = True
        return

    now = datetime.now(timezone.utc)
    async with session_factory() as db:
        recips = [r[0] for r in (await db.execute(text(
            "SELECT email FROM ems_mail_recipient WHERE notify_enabled = TRUE"
        ))).fetchall()]
        if not recips:
            log.debug("mail_worker: 無 enabled 收件人 → skip")
            return

        events = (await db.execute(text("""
            SELECT event_id, ts, severity, source, device_id, message, data_json,
                   mail_send_count, last_mail_sent_at
            FROM ems_events
            WHERE notify_pananora = TRUE AND resolved_at IS NULL
            ORDER BY ts ASC
        """))).mappings().all()

        sent = 0
        for ev in events:
            count = ev["mail_send_count"] or 0
            interval = INTERVALS.get(count, DEFAULT_INTERVAL)
            ref = ev["last_mail_sent_at"] or ev["ts"]
            elapsed = (now - ref).total_seconds()
            if elapsed < interval:
                continue

            subject = f"[Tydares EMS 告警] {sev_label(ev['severity'])} {ev['device_id'] or ''}".strip()
            body = _build_body(dict(ev))
            try:
                await asyncio.to_thread(_send_mail_blocking, subject, body, recips)
            except Exception as e:
                log.warning("mail send failed event=%s: %s", ev["event_id"], e)
                continue  # 不更新 → 下次 scan 重試

            await db.execute(text("""
                UPDATE ems_events
                SET last_mail_sent_at = NOW(),
                    mail_send_count = mail_send_count + 1,
                    mail_sent_at = COALESCE(mail_sent_at, NOW())
                WHERE event_id = :id
            """), {"id": ev["event_id"]})
            sent += 1

        if sent:
            await db.commit()
            log.info("mail_worker tick: sent=%d to %d recipient(s)", sent, len(recips))


async def mail_worker_loop(session_factory: async_sessionmaker) -> None:
    log.info("mail_worker_loop started (scan=%ss intervals=0/4h/12h/24h; M-PM-313)", SCAN_SEC)
    while True:
        try:
            await mail_worker_tick(session_factory)
        except Exception as e:  # pragma: no cover
            log.exception("mail_worker tick failed: %s", e)
        await asyncio.sleep(SCAN_SEC)
