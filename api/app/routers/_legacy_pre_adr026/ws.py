"""WebSocket endpoint for realtime data push.

Clients connect to /ws and receive JSON messages when new data arrives.
Used by frontend for: realtime report, single-line diagram, thermal view.

Message format:
  {"type": "ingest", "device_id": "...", "data": {...}}
  {"type": "command_update", "command_id": "...", "status": "..."}
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Set

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

log = logging.getLogger("websocket")

router = APIRouter()

# Connected clients
_clients: Set[WebSocket] = set()


async def broadcast(message: dict) -> None:
    """Broadcast a message to all connected WebSocket clients."""
    global _clients
    if not _clients:
        return
    payload = json.dumps(message, default=str)
    disconnected = set()
    for ws in _clients.copy():
        try:
            await ws.send_text(payload)
        except Exception:
            disconnected.add(ws)
    _clients -= disconnected


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    _clients.add(websocket)
    log.info("WebSocket client connected (%d total)", len(_clients))

    try:
        while True:
            # Keep connection alive; client can send ping/commands
            data = await websocket.receive_text()
            # Echo back for now (can be used for subscribe/filter)
            if data == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        pass
    finally:
        _clients.discard(websocket)
        log.info("WebSocket client disconnected (%d remaining)", len(_clients))
