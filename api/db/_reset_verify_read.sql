-- M-PM-323v2 Real Verify 善後：清掉端到端測試標的已讀標記，保持 production 乾淨
UPDATE ems_alert_history SET read_at = NULL, read_by = NULL WHERE read_by = 'M-PM-323v2_verify';
SELECT COUNT(*) AS remaining_verify_marks FROM ems_alert_history WHERE read_by = 'M-PM-323v2_verify';
