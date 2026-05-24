#!/usr/bin/env bash
# admin-ui deploy.sh — VM102 nginx static serving 部署 SOP
#
# 起源：M-PM-263（PM dispatch 5/22）/ M-P11-E26（P11E 5/22 升報候選）
# 防再犯：M-P11-E23 Reports ECSU 化 commit 落地 git tree 後，frontend bundle 從未 scp
#         上 VM102 → 老王 hard reload 看到孤兒 index.html 指 missing bundle → 業務驗收阻塞
#
# 部署架構（M-P10D-005 + M-P11-E26 採證）：
#   host:  /opt/ems-central/ui/admin/          ← 本 script 推目標
#   mount: ems-nginx /var/www/admin (ro)
#   vhost: :8080 (M-PM-263 既建) + admin.tydares.internal (M-PM-259 既建)
#
# 用法：
#   ./scripts/deploy.sh                # 預設 Tailscale 100.70.196.32（業主離場）
#   TARGET=192.168.10.202 ./scripts/deploy.sh   # 業主現地 LAN（v1.4 §56）
#   SKIP_BUILD=1 ./scripts/deploy.sh   # 已 build 過直接推
#
# 紀律：
#   - v1.4 §53 業主明示：執行前確認老王 chat 授權部署
#   - v1.4 §56 LAN routing：業主現地走 192.168.10.X / 離場走 Tailscale
#   - M-PM-027：本 script 不動 backend / schema / Pananora / nginx config
#   - M-PM-065 §三：deploy 後 curl Real Verify 全綠才算完工

set -euo pipefail

TARGET="${TARGET:-100.70.196.32}"
SSH_USER="${SSH_USER:-root}"
REMOTE_DIR="${REMOTE_DIR:-/opt/ems-central/ui/admin}"
ADMIN_VHOST_PORT="${ADMIN_VHOST_PORT:-8080}"
SKIP_BUILD="${SKIP_BUILD:-}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADMIN_UI_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "═══════════════════════════════════════════════════════"
echo "admin-ui deploy.sh"
echo "  TARGET     = $SSH_USER@$TARGET"
echo "  REMOTE_DIR = $REMOTE_DIR"
echo "  ADMIN_UI   = $ADMIN_UI_DIR"
echo "  TIMESTAMP  = $TIMESTAMP"
echo "═══════════════════════════════════════════════════════"

# ── Step 1：build（除非 SKIP_BUILD=1）────────────────────────
if [ -z "$SKIP_BUILD" ]; then
  echo
  echo "[1/5] npm run build（clean dist/）"
  cd "$ADMIN_UI_DIR"
  rm -rf dist/
  npm run build
else
  echo
  echo "[1/5] SKIP_BUILD=1 → 用既有 dist/"
fi

# ── Step 2：採證 local dist/ 結構 ────────────────────────────
echo
echo "[2/5] 採證 local dist/"
cd "$ADMIN_UI_DIR"
if [ ! -d dist/assets ] || [ ! -f dist/index.html ]; then
  echo "❌ dist/ 結構不對；缺 assets/ 或 index.html"
  exit 1
fi
LOCAL_BUNDLE="$(grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' dist/index.html | head -1)"
echo "  local bundle: $LOCAL_BUNDLE"
if [ -z "$LOCAL_BUNDLE" ]; then
  echo "❌ dist/index.html 找不到 script tag"
  exit 1
fi

# ── Step 3：備份 VM102 既有 admin/ ───────────────────────────
echo
echo "[3/5] 備份 VM102 $REMOTE_DIR → $REMOTE_DIR.bak.$TIMESTAMP"
ssh "$SSH_USER@$TARGET" "cp -r $REMOTE_DIR $REMOTE_DIR.bak.$TIMESTAMP && echo OK"

# ── Step 4：tar pipe dist/ → VM102 + 清孤兒 assets/ ──────────
echo
echo "[4/5] tar pipe dist/ → $TARGET:$REMOTE_DIR + 清孤兒 assets/"
tar cf - -C dist . | ssh "$SSH_USER@$TARGET" "rm -rf $REMOTE_DIR/assets/* && tar xf - -C $REMOTE_DIR"

# ── Step 5：Real Verify curl ─────────────────────────────────
echo
echo "[5/5] Real Verify curl"
REMOTE_BUNDLE="$(ssh "$SSH_USER@$TARGET" "grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' $REMOTE_DIR/index.html | head -1")"
echo "  remote bundle: $REMOTE_BUNDLE"
if [ "$LOCAL_BUNDLE" != "$REMOTE_BUNDLE" ]; then
  echo "❌ local vs remote bundle hash 不符；deploy 異常"
  exit 1
fi

HTTP_CODE=$(ssh "$SSH_USER@$TARGET" "curl -s -o /dev/null -w '%{http_code}' http://localhost:$ADMIN_VHOST_PORT/$LOCAL_BUNDLE")
echo "  curl admin :$ADMIN_VHOST_PORT/$LOCAL_BUNDLE → HTTP $HTTP_CODE"
if [ "$HTTP_CODE" != "200" ]; then
  echo "❌ bundle HTTP code != 200"
  exit 1
fi

FRONTEND_CODE=$(ssh "$SSH_USER@$TARGET" "curl -s -o /dev/null -w '%{http_code}' http://localhost/")
echo "  curl frontend :80 → HTTP $FRONTEND_CODE（前台不破檢查）"

echo
echo "═══════════════════════════════════════════════════════"
echo "✅ admin-ui deploy 完成"
echo "  bundle:  $LOCAL_BUNDLE"
echo "  vhost:   http://$TARGET:$ADMIN_VHOST_PORT/"
echo "  backup:  $REMOTE_DIR.bak.$TIMESTAMP（保留供 rollback；N 天後清）"
echo
echo "  下一步：通知老王 hard reload 驗收"
echo "═══════════════════════════════════════════════════════"
