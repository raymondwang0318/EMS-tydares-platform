-- ECSU 清單核對執行前採證（唯讀，2026-06-15）
\echo === 1. fnd_ecsu schema ===
\d fnd_ecsu
\echo === 2. fnd_ecsu_circuit_assgn schema ===
\d fnd_ecsu_circuit_assgn
\echo === 3. 刪除候選(63/65/66/120/121) + 植物防疫(110/111) 的綁定現況 ===
SELECT e.ecsu_code, e.region, e.ecsu_name,
       COUNT(a.assgn_id) AS bindings,
       string_agg(DISTINCT a.circuit_code, ', ') AS circuits
FROM fnd_ecsu e
LEFT JOIN fnd_ecsu_circuit_assgn a ON a.ecsu_id = e.ecsu_id
WHERE e.ecsu_code IN ('KW-63','KW-65','KW-66','KW-120','KW-121','KW-110','KW-111')
GROUP BY 1,2,3 ORDER BY 1;
\echo === 4. KW-86 是否存在（老王裁示忽略，確認在不在）===
SELECT ecsu_code, region, ecsu_name FROM fnd_ecsu WHERE ecsu_code = 'KW-86';
\echo === 5. 新增 68/69 參考：同段 I 區 KW-67/KW-50 完整 row（看必填欄）===
SELECT * FROM fnd_ecsu WHERE ecsu_code IN ('KW-67','KW-50');
\echo === 6. 68/69 是否已存在（避免重複新增）===
SELECT ecsu_code FROM fnd_ecsu WHERE ecsu_code IN ('KW-68','KW-69');
