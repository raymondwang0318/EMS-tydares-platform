"""MQTT Wake-up Sender (Central-side minimal unit).

定位（重要）：
- 這是一個「最小可用」的 wake-up signal 發送腳本，用於端到端手動測試。
- 不代表 Central runtime 已完整存在；也不承諾任何指令派發能力。

Wake-up Contract（MQTT Signal-only）對齊：
- Signal payload 僅包含最小欄位（type/ts/correlation_id），不含任何指令內容
- Topic 由呼叫端指定（或用 site_id/edge_id 組出預設）

用法（範例）：
  python mqtt_wakeup_sender.py --broker 127.0.0.1 --topic ems/wakeup/site-default/edge-local

依賴：
  pip install paho-mqtt
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import uuid

try:
    import paho.mqtt.client as mqtt
except ImportError:  # pragma: no cover
    mqtt = None  # type: ignore


def _iso_ts() -> str:
    # Using epoch seconds as string is enough for the contract; keep it simple.
    return str(int(time.time()))


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Central MQTT wake-up sender (signal-only).")
    parser.add_argument("--broker", required=True, help="MQTT broker host, e.g. 127.0.0.1")
    parser.add_argument("--port", type=int, default=1883, help="MQTT broker port (default: 1883)")
    parser.add_argument("--qos", type=int, default=1, choices=(0, 1, 2), help="MQTT QoS (default: 1)")
    parser.add_argument("--keepalive", type=int, default=60, help="MQTT keepalive seconds (default: 60)")

    parser.add_argument("--topic", default="", help="Wake-up topic, e.g. ems/wakeup/{site_id}/{edge_id}")
    parser.add_argument("--site-id", default="site-default", help="Used to build default topic if --topic empty")
    parser.add_argument("--edge-id", default="edge-local", help="Used to build default topic if --topic empty")

    parser.add_argument("--type", default="WAKEUP", help="Signal type (default: WAKEUP)")
    parser.add_argument("--correlation-id", default="", help="Optional correlation id (uuid). Auto-generated if empty.")
    args = parser.parse_args(argv)

    if mqtt is None:
        print("ERROR: paho-mqtt not installed. Run: pip install paho-mqtt", file=sys.stderr)
        return 2

    topic = args.topic.strip() or f"ems/wakeup/{args.site_id}/{args.edge_id}"
    correlation_id = args.correlation_id.strip() or str(uuid.uuid4())

    payload = {
        "type": args.type,
        "ts": _iso_ts(),
        "correlation_id": correlation_id,
    }
    payload_bytes = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")

    client = mqtt.Client(client_id=f"central-wakeup-{uuid.uuid4()}", clean_session=True)
    client.connect(args.broker, args.port, args.keepalive)

    # publish once, then disconnect
    info = client.publish(topic, payload_bytes, qos=int(args.qos), retain=False)
    info.wait_for_publish(timeout=5.0)
    client.disconnect()

    print(f"OK: published wake-up signal topic={topic} qos={args.qos} correlation_id={correlation_id}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main(sys.argv[1:]))

