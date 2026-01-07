-- EMS-tydares-central / 01-core-platform
-- ORDS package scaffold (PL/SQL)

CREATE OR REPLACE PACKAGE ems_core_pkg AS
  FUNCTION health_check RETURN VARCHAR2;
END ems_core_pkg;
/

CREATE OR REPLACE PACKAGE BODY ems_core_pkg AS
  FUNCTION health_check RETURN VARCHAR2 IS
  BEGIN
    RETURN 'OK';
  END health_check;
END ems_core_pkg;
/
