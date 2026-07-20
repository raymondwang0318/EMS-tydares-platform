DELETE FROM ems_admin_session WHERE session_id = 'p12a-verify-viewer-20260617';
UPDATE ems_admin_user SET can_control_io = FALSE WHERE username = 'user';
SELECT 'cleanup: user io=' || can_control_io AS status FROM ems_admin_user WHERE username = 'user';
SELECT 'leftover sessions=' || COUNT(*) AS sess FROM ems_admin_session WHERE session_id = 'p12a-verify-viewer-20260617';
