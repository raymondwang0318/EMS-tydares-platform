/**
 * M-PM-173 T-Reports-002 §AC 2-4: Energy 報表 Excel 匯出 hook
 *
 * 純前端 SheetJS（xlsx）；M-PM-159 §採方案 A：純 frontend；不阻 backend stream xlsx 升級路徑
 *
 * 升級準備度 NFR（M-PM-173 §2.2）：
 *   未來 Phase B 換 backend stream xlsx 時，hook 內部換 fetch → 10 行；UI / 按鈕 / 檔名 / 欄位映射 → 0 改動
 *
 * 用法：
 *   const { exportToExcel, isExporting } = useReportExport();
 *   exportToExcel({ rows, columns, filename: '用電履歷_xxx.xlsx', sheetName: 'Energy' });
 */
import { useCallback, useState } from 'react';
import * as XLSX from 'xlsx';

export interface ExportColumn<TRow> {
  /** 欄位 key（rows[i][key] 取值）*/
  key: keyof TRow | string;
  /** Excel 顯示中文 header */
  header: string;
  /** Optional render 函式（同 Ant Table render；返回字串 / 數字）；未給走 row[key] */
  render?: (row: TRow) => string | number | null | undefined;
  /** Optional 欄寬（character count；undefined → auto by header.length）*/
  width?: number;
}

export interface ExportOptions<TRow> {
  rows: TRow[];
  columns: ExportColumn<TRow>[];
  filename: string;
  sheetName?: string;
}

export function useReportExport() {
  const [isExporting, setIsExporting] = useState(false);

  const exportToExcel = useCallback(<TRow,>(opts: ExportOptions<TRow>) => {
    setIsExporting(true);
    try {
      const { rows, columns, filename, sheetName = 'Sheet1' } = opts;

      // 1. 建 array-of-objects（中文 header → cell value）
      const data = rows.map((row) => {
        const obj: Record<string, string | number | null | undefined> = {};
        for (const col of columns) {
          const v = col.render
            ? col.render(row)
            : (row[col.key as keyof TRow] as unknown as string | number | null | undefined);
          obj[col.header] = v;
        }
        return obj;
      });

      // 2. SheetJS workbook
      const ws = XLSX.utils.json_to_sheet(data, {
        header: columns.map((c) => c.header),
      });

      // 3. 欄寬 auto（character count；min 8 / max 30）
      ws['!cols'] = columns.map((c) => ({
        wch: Math.max(8, Math.min(30, c.width ?? c.header.length * 2)),
      }));

      // 4. 凍結第 1 列
      ws['!freeze'] = { xSplit: 0, ySplit: 1, topLeftCell: 'A2', activePane: 'bottomLeft' };

      // 5. 標題粗體（apply to row 0；不是所有 viewer 都會 honor styling；MVP 先省）
      // SheetJS community version 對 styling 支援有限；老王驗證後若需求強再升 xlsx-js-style

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, sheetName);

      // 6. 下載（瀏覽器 trigger Save dialog）
      XLSX.writeFile(wb, filename);
    } catch (err) {
      console.error('[useReportExport] failed', err);
      throw err;
    } finally {
      setIsExporting(false);
    }
  }, []);

  return { exportToExcel, isExporting };
}
