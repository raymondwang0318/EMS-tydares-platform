BEGIN
  ORDS.enable_schema(
    p_enabled             => TRUE,
    p_schema              => USER,
    p_url_mapping_type    => 'BASE_PATH',
    p_url_mapping_pattern => 'ems',
    p_auto_rest_auth      => FALSE
  );
END;
/
