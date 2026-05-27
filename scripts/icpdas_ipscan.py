#!/usr/bin/env python3
"""ICP DAS iSN-811C IR camera IP scanner (ems-ipscan container core).

M-P11-E36 §4 兌現：底層自動化掃描 iSN-811C IR 設備 IP 對應；業主 0 操作 eSearch.exe.

採證鐵證 (老王 5/27 eSearch screenshot)：
- 設備類型: iSN-811C-MTCP (ICP DAS)
- OUI: 00:0d:e0:92:* (ICP DAS 公開 MAC prefix)
- 同 LAN: 192.168.10.0/24 (跟 VM102 192.168.10.202 同網段)
- 14 devices found (192.168.10.80~95 range; DHCP OFF 靜態 IP)
- device_id naming: 811c_<mac:lower:colon→dash> e.g. 811c_00-0d-e0-92-11-55

實作策略：
- 不走 ICP DAS UDP discovery protocol (避免採證 packet 結構;業主 0 配合)
- 改用 Linux 通用 ARP scan (arp-scan tool;通過 Layer-2 ARP 直接撈 MAC↔IP)
- 廠商 OUI filter: only 00:0d:e0:* (避免上報無關 device)
- POST 上報 ems-api /v1/admin/ir-devices/ip-scan-report (bulk UPSERT)

Event-driven trigger 模式 (預設 startup-once;cron 升報候選):
- 預設: container 啟動跑 1 次 + sleep 持續 (主進程不死)
- 進階: 加 inotify / poll trx_reading 新 device_id 觸發 (M-P11-E36 §一升報候選)

Usage:
    python3 icpdas_ipscan.py [--subnet 192.168.10.0/24] [--oui 00:0d:e0] \\
                             [--api-url http://ems-api:8000] [--token ...]

Environment:
    ICPDAS_SUBNET     scan subnet (default: 192.168.10.0/24)
    ICPDAS_OUI        MAC prefix filter (default: 00:0d:e0)
    EMS_API_URL       Central API URL (default: http://localhost:8000)
    EMS_API_TOKEN     Bearer token (優先;單獨 token)
    AUTH_TOKENS       JSON array ["CHANGE_ME","ems_edge_..."] (fallback;對齊 .env 既建)
    SCAN_INTERVAL_SEC interval between scans (default: 0 = run once;>0 = loop)
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone


# ARP-scan output line pattern (vendor 欄 optional;--quiet 模式無 vendor):
#   192.168.10.83   00:0d:e0:92:11:55   ICP DAS Co., Ltd.  (default mode)
#   192.168.10.83   00:0d:e0:92:11:55                       (--quiet mode)
_ARP_LINE = re.compile(
    r"^(\d+\.\d+\.\d+\.\d+)\s+([0-9a-fA-F:]{17})(?:\s+(.*))?$"
)


def run_arp_scan(subnet: str, interface: str | None = None) -> list[tuple[str, str, str]]:
    """Run arp-scan on subnet; return list of (ip, mac, vendor) tuples.

    Requires arp-scan tool installed (apt install arp-scan).
    Requires root or CAP_NET_RAW (container handles via host network).
    """
    # NB: 不用 --quiet (會去掉 vendor 欄);保留預設給 OUI vendor 對 debug 有用
    cmd = ["arp-scan"]
    if interface:
        cmd.extend(["--interface", interface])
    cmd.append(subnet)

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30, check=False)
    except FileNotFoundError:
        print("[ERROR] arp-scan not installed. Install via: apt install arp-scan", file=sys.stderr)
        return []
    except subprocess.TimeoutExpired:
        print(f"[ERROR] arp-scan timeout (subnet={subnet})", file=sys.stderr)
        return []

    if result.returncode != 0:
        print(f"[WARN] arp-scan returncode={result.returncode}: {result.stderr[:200]}", file=sys.stderr)

    devices = []
    for line in result.stdout.splitlines():
        m = _ARP_LINE.match(line.strip())
        if m:
            ip, mac, vendor = m.groups()
            devices.append((ip, mac.lower(), vendor or ""))
    return devices


def filter_oui(devices: list[tuple[str, str, str]], oui_prefix: str) -> list[tuple[str, str]]:
    """Filter devices by MAC OUI prefix (e.g. '00:0d:e0'); return [(mac, ip), ...]."""
    oui_lower = oui_prefix.lower()
    return [(mac, ip) for (ip, mac, _vendor) in devices if mac.startswith(oui_lower)]


def post_report(api_url: str, token: str, devices: list[tuple[str, str]]) -> dict:
    """POST scanned devices to /v1/admin/ir-devices/ip-scan-report (bulk UPSERT)."""
    payload = {
        "scanned_at": datetime.now(timezone.utc).isoformat(),
        "devices": [{"mac": mac, "ip": ip} for (mac, ip) in devices],
    }
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{api_url.rstrip('/')}/v1/admin/ir-devices/ip-scan-report",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as exc:
        print(f"[ERROR] POST failed: {exc}", file=sys.stderr)
        return {"error": str(exc)}


def scan_once(subnet: str, oui: str, api_url: str, token: str, interface: str | None) -> dict:
    """Run 1 scan iteration: arp-scan → filter OUI → POST report."""
    print(f"[{datetime.now(timezone.utc).isoformat()}] scanning {subnet} (OUI={oui})...")
    all_devices = run_arp_scan(subnet, interface=interface)
    filtered = filter_oui(all_devices, oui)
    print(f"  arp-scan total={len(all_devices)} / OUI-matched={len(filtered)}")
    for mac, ip in filtered:
        print(f"    {mac}  {ip}")

    if not filtered:
        print("  no matched devices; skip report")
        return {"matched": 0}

    report_result = post_report(api_url, token, filtered)
    print(f"  report result: {report_result}")
    return report_result


def _resolve_token() -> str:
    """Resolve API token from env: EMS_API_TOKEN (優先) or AUTH_TOKENS JSON array (fallback).

    AUTH_TOKENS pattern: '["CHANGE_ME","ems_edge_..."]' (對齊 .env 既建).
    取第一個 non-'CHANGE_ME' token.
    """
    direct = os.getenv("EMS_API_TOKEN", "").strip()
    if direct:
        return direct
    auth_tokens_raw = os.getenv("AUTH_TOKENS", "").strip()
    if auth_tokens_raw:
        try:
            tokens = json.loads(auth_tokens_raw)
            for t in tokens:
                if t and t != "CHANGE_ME":
                    return t
        except (json.JSONDecodeError, TypeError):
            pass
    return ""


def main():
    parser = argparse.ArgumentParser(description="ICP DAS iSN-811C IP scanner")
    parser.add_argument("--subnet", default=os.getenv("ICPDAS_SUBNET", "192.168.10.0/24"))
    parser.add_argument("--oui", default=os.getenv("ICPDAS_OUI", "00:0d:e0"))
    parser.add_argument("--api-url", default=os.getenv("EMS_API_URL", "http://localhost:8000"))
    parser.add_argument("--token", default=_resolve_token())
    parser.add_argument("--interface", default=os.getenv("ICPDAS_IFACE"))
    parser.add_argument("--interval", type=int, default=int(os.getenv("SCAN_INTERVAL_SEC", "0")),
                        help="interval between scans (0 = once and exit; >0 = loop forever)")
    args = parser.parse_args()

    if not args.token:
        print("[ERROR] EMS_API_TOKEN or AUTH_TOKENS env required", file=sys.stderr)
        sys.exit(2)

    # 1 次 scan + optional loop
    while True:
        try:
            scan_once(args.subnet, args.oui, args.api_url, args.token, args.interface)
        except Exception as exc:
            print(f"[ERROR] scan_once raised: {exc}", file=sys.stderr)
        if args.interval <= 0:
            break
        print(f"  sleeping {args.interval} sec until next scan...")
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
