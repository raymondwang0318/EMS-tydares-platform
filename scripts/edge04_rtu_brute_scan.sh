#!/bin/bash
# Edge04 RTU brute scan slave 1-30
#
# 用途：透過 Central /v1/commands → Edge04 BusRuntime 觸發 device.scan
#       掃描 slave 1-30 哪些回應（不直接開 ttyS0；遵守 Bus Arbiter 鐵律）
#
# 用法：
#   bash edge04_rtu_brute_scan.sh
#   # 預設掃 slave 1-30 with device_type=cpm23
#
#   bash edge04_rtu_brute_scan.sh aem_drb 1 50
#   # 改 device_type=aem_drb；slave range 1-50
#
# 設計：
#   1. POST /v1/commands edge-level device.scan with scan_plan [1..30]
#   2. Edge04 BusRuntime 排隊執行 fc=3 (timeout 5s/slave) — 預估 ~150s
#   3. Poll /v1/commands/detail/{cmd_id} 每 5 秒直到 SUCCEEDED
#   4. 列印 scan_results 表（slave / online / error）
#
# 鐵律遵守：
#   - 不 ssh edge04 開 /dev/ttyS0
#   - 走 Central API → Edge04 BusRuntime（單一仲裁器）
#   - 不停 daemon；不繞過

set -euo pipefail

DEVICE_TYPE="${1:-cpm23}"
START="${2:-1}"
END="${3:-30}"
EDGE_ID="${EDGE_ID:-TYDARES-E04}"
HOST="${HOST:-http://100.70.196.32:8080}"
TOKEN="${TOKEN:-ems_edge_260f002899b9a94611bc5e96b3aa039c}"

echo "=== Edge04 RTU brute scan ==="
echo "edge_id     : $EDGE_ID"
echo "device_type : $DEVICE_TYPE"
echo "slave range : $START-$END"
echo "host        : $HOST"
echo ""

# Build payload
PAYLOAD=$(python3 -c "
import json
plan = [{'slave_id': i, 'device_type': '$DEVICE_TYPE'} for i in range($START, $END + 1)]
body = {
  'edge_id': '$EDGE_ID',
  'command_type': 'device.scan',
  'issued_by': 'p11-bruteforce',
  'payload': {
    'scan_plan': plan,
    'transport': 'rs485',
    'port': '/dev/ttyS0',
    'baudrate': 9600,
    'phase2': True,
    'auto_confirm': False
  }
}
print(json.dumps(body))
")

# POST
echo ">>> POST /v1/commands ..."
RESP=$(curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  "$HOST/v1/commands")

CMDID=$(echo "$RESP" | python3 -c "import json,sys; print(json.load(sys.stdin).get('command_id',''))" 2>/dev/null || echo "")

if [[ -z "$CMDID" ]]; then
  echo "❌ POST 失敗 / 無 command_id"
  echo "Response: $RESP"
  exit 1
fi

echo "    cmd_id = $CMDID"
echo ""

# Poll
EXPECTED_DURATION=$((END - START + 1) * 5 + 30)
MAX_POLLS=$((EXPECTED_DURATION / 5 + 12))
echo ">>> Polling ($MAX_POLLS × 5s; 預估 ${EXPECTED_DURATION}s) ..."

for ((i=1; i<=MAX_POLLS; i++)); do
  sleep 5
  DETAIL=$(curl -s -H "Authorization: Bearer $TOKEN" "$HOST/v1/commands/detail/$CMDID")
  STATUS=$(echo "$DETAIL" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    print(d.get('status', '?') if d else 'NULL')
except Exception as e:
    print(f'ERR:{e}')
" 2>/dev/null || echo "?")

  echo "    [$((i*5))s] status=$STATUS"

  if [[ "$STATUS" == "SUCCEEDED" || "$STATUS" == "FAILED" || "$STATUS" == "EXPIRED" || "$STATUS" == "CANCELED" ]]; then
    break
  fi
done

echo ""
echo ">>> Final result ==="

curl -s -H "Authorization: Bearer $TOKEN" "$HOST/v1/commands/detail/$CMDID" | python3 -c "
import json, sys

try:
    d = json.load(sys.stdin)
except Exception as e:
    print(f'❌ JSON parse error: {e}')
    sys.exit(1)

if not d:
    print('❌ Response is null (cmd 不存在 / persistence bug)')
    sys.exit(1)

print(f\"command_id : {d.get('command_id', '?')}\")
print(f\"status     : {d.get('status', '?')}\")
print(f\"latency_ms : {d.get('result_json', {}).get('latency_ms', '?')}\")
print()

results = d.get('result_json', {}).get('scan_results', [])
if not results:
    print('❌ scan_results 空')
    sys.exit(0)

# 排序顯示
results.sort(key=lambda x: x.get('slave_id', 0))

print('=== Edge04 RTU brute scan results ===')
print(f\"{'slave':>5}  {'online':>6}  {'type':<10}  {'circuits':<8}  {'error':<70}\")
print('-' * 110)

online_slaves = []
for r in results:
    s = r.get('slave_id', '?')
    online = r.get('online', False)
    o_mark = '✅' if online else '❌'
    t = r.get('device_type', '?')
    circuits = len(r.get('circuits') or [])
    err = (r.get('error') or '')[:68]
    print(f\"{s:>5}  {o_mark:>6}  {t:<10}  {circuits:<8}  {err:<70}\")
    if online:
        online_slaves.append(s)

print()
print(f'>>> 在線 slave count: {len(online_slaves)}')
if online_slaves:
    print(f'>>> 在線 slave 列表 : {online_slaves}')
"
