UPDATE ems_admin_user SET can_control_io = TRUE WHERE username = 'user';
SELECT 'user io=' || can_control_io AS status FROM ems_admin_user WHERE username = 'user';
