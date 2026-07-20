# ui/ — nginx 部署產物目錄（勿手改、勿當 source）

- `ui/frontend/` → nginx 掛載 `/var/www/ems`（前台靜態頁，LIVE）
- `ui/admin/`    → nginx 掛載 `/var/www/admin`（admin-ui 的 build 產物，LIVE）

**admin 後台的 source 在本 repo 的 `admin-ui/`**（React/Vite）。
部署流程：`cd admin-ui && npm run build` → 產物 cp 到 `ui/admin/` → VM102 nginx reload。
（A3 死碼清理 2026-07-20 註：本目錄曾被誤判為「舊前端死碼」，實為 LIVE 部署目錄。）
