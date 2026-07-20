\pset pager off
\echo === ECSU ↔ 電表迴路 真實對應（全 93 筆，含未綁定）===
SELECT e.ecsu_code AS kw, e.region AS 區,
       e.ecsu_name AS 名稱,
       COALESCE(a.device_id, '（未綁電表）') AS 電表device_id,
       a.circuit_code AS 迴路, a.sign AS 號, a.enabled AS 啟用
FROM fnd_ecsu e
LEFT JOIN fnd_ecsu_circuit_assgn a ON a.ecsu_id = e.ecsu_id
ORDER BY CAST(regexp_replace(e.ecsu_code, '\D','','g') AS INT), a.circuit_code;
\echo === 統計：有綁定 vs 未綁定 ===
SELECT CASE WHEN a.assgn_id IS NULL THEN '未綁電表' ELSE '有綁定' END AS 狀態, COUNT(DISTINCT e.ecsu_id) AS ecsu數
FROM fnd_ecsu e LEFT JOIN fnd_ecsu_circuit_assgn a ON a.ecsu_id=e.ecsu_id GROUP BY 1;
\echo === 反向檢查：同一電表迴路被多個 ECSU 綁（潛在重複/扣除關係）===
SELECT a.device_id, a.circuit_code, COUNT(*) AS 綁定數, string_agg(e.ecsu_code, ', ' ORDER BY e.ecsu_code) AS 被哪些ECSU綁
FROM fnd_ecsu_circuit_assgn a JOIN fnd_ecsu e ON e.ecsu_id=a.ecsu_id
GROUP BY 1,2 HAVING COUNT(*) > 1 ORDER BY 3 DESC;
