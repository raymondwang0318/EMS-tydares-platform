#!/usr/bin/env bash
set -euo pipefail

HOST="https://<host>"

DEVICE_ID="gateway-01"

curl -X POST "$HOST/ords/ems/ingest/$DEVICE_ID" \
  -H "Content-Type: application/json" \
  -H "X-Idempotency-Key: test-uuid-001" \
  -d '{
    "ts": "2026-01-07T10:00:00+08:00",
    "type": "meter_reading",
    "device_id": "gateway-01",
    "payload": {
      "kwh": 123.45,
      "kw": 3.2
    }
  }'
