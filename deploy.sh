#!/bin/bash
# Tydares EMS — Docker deploy to VM102
# Usage: bash deploy.sh
#
# 所有服務都跑在 Docker 裡：
#   ems-api      FastAPI (internal :8000)
#   ems-worker   Background worker
#   ems-nginx    Nginx (前台 :80, 後台 :8080)
#   ems-mosquitto MQTT (:1883)

set -e

VM102="100.70.196.32"
REMOTE_DIR="/opt/ems-central"

echo "=== Packing project ==="
tar czf /tmp/ems-deploy.tar.gz \
  api/ \
  nginx/default.conf \
  mosquitto/mosquitto.conf \
  ui/ \
  docker-compose.yml

echo "=== Transferring to VM102 ==="
scp -o StrictHostKeyChecking=no /tmp/ems-deploy.tar.gz "root@${VM102}:/tmp/"

echo "=== Deploying ==="
ssh -o StrictHostKeyChecking=no "root@${VM102}" "
  cd ${REMOTE_DIR}
  tar xzf /tmp/ems-deploy.tar.gz
  docker compose down
  docker compose up -d --build
  sleep 5
  docker compose ps
  echo ''
  echo '=== Health check ==='
  curl -sf http://localhost:8000/health || curl -sf http://localhost:80/health
  echo ''
  echo '=== Deploy complete ==='
"
