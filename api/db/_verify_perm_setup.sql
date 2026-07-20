-- Real Verify 用：建臨時 viewer session 測 can_control_io 安全鎖（測完 cleanup 刪）
INSERT INTO ems_admin_session (session_id, user_id, expires_at)
SELECT 'p12a-verify-viewer-20260617', user_id, now() + interval '1 hour'
FROM ems_admin_user WHERE username = 'user'
ON CONFLICT (session_id) DO UPDATE SET expires_at = now() + interval '1 hour';
SELECT 'viewer session ready; user io=' || can_control_io AS status
FROM ems_admin_user WHERE username = 'user';
