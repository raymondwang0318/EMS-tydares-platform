"""MQTT wake-up signal publisher.

在建立命令時發送 MQTT signal，通知 Edge 立即拉取指令。
Signal-only 合約：payload 僅含 type/ts/correlation_id，不含任何指令內容。

Edge 端由 edge/wakeup/wakeup_listener.py 接收，觸發 wake_event 中斷 sleep 進入 polling。
"""

from __future__ import annotations

import json
import logging
import os
import time
import uuid
from typing import Optional

try:
    import paho.mqtt.client as mqtt
except ImportError:
    mqtt = None  # type: ignore

log = logging.getLogger(__name__)

MQTT_BROKER = os.getenv("MQTT_BROKER_HOST", "ems-mosquitto")
MQTT_PORT = int(os.getenv("MQTT_BROKER_PORT", "1883"))
DEFAULT_SITE_ID = os.getenv("WAKEUP_DEFAULT_SITE_ID", "site-default")

_client: Optional["mqtt.Client"] = None


def _get_client() -> Optional["mqtt.Client"]:
    """Lazy-init MQTT client, reconnect if dropped."""
    global _client
    if mqtt is None:
        return None
    if _client is not None and _client.is_connected():
        return _client
    try:
        client = mqtt.Client(client_id=f"central-wakeup-{uuid.uuid4().hex[:8]}", clean_session=True)
        client.connect(MQTT_BROKER, MQTT_PORT, keepalive=60)
        client.loop_start()
        _client = client
        log.info("MQTT wake-up publisher connected: %s:%d", MQTT_BROKER, MQTT_PORT)
        return _client
    except Exception:
        log.warning("Failed to connect MQTT wake-up publisher", exc_info=True)
        return None


def send_wakeup(edge_id: str, site_id: str = DEFAULT_SITE_ID) -> None:
    """發送 wake-up signal 給指定 Edge。

    Non-fatal: 失敗不影響主要流程，Edge 會在下一輪 polling 領取。
    """
    if not edge_id:
        return

    client = _get_client()
    if client is None:
        log.debug("MQTT client unavailable; skip wake-up signal")
        return

    topic = f"ems/wakeup/{site_id}/{edge_id}"
    payload = json.dumps({
        "type": "WAKEUP",
        "ts": str(int(time.time())),
        "correlation_id": str(uuid.uuid4()),
    }, separators=(",", ":"))

    try:
        info = client.publish(topic, payload.encode("utf-8"), qos=1)
        info.wait_for_publish(timeout=2.0)
        log.info("Wake-up signal sent: topic=%s", topic)
    except Exception:
        log.warning("Failed to publish wake-up signal (non-fatal)", exc_info=True)
