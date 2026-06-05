/**
 * ems_events 事件中文化（M-PM-306 異常履歷頁；老王 2026-06-04）
 *
 * 老王明示：訊息內容用繁體中文描述，特殊專有名詞保持原文。
 *   - 保留原文：device_id / ecsu_id / circuit_code / command_type / token /
 *     fingerprint / hostname / Edge / ECSU / IR / Wizard / status 值等
 *   - 中文化：動作描述部分
 *
 * 採證來源：command_service.py + v1_admin.py 所有 message= 字串（2026-06-04）。
 * 未知樣式 fallback 回原文（不破壞）。
 */

// event_kind → 繁中標籤（ems_events CHECK: command|operation|comm_abn|edge_lifecycle|config_sync）
const KIND_LABEL: Record<string, string> = {
  command: '指令',
  operation: '操作',
  comm_abn: '通訊異常',
  edge_lifecycle: 'Edge 生命週期',
  config_sync: '設定同步',
};

export function kindLabel(kind: string | null): string {
  return (kind && KIND_LABEL[kind]) || kind || '—';
}

// severity → 繁中
const SEV_LABEL: Record<string, string> = {
  error: '錯誤',
  critical: '嚴重',
  fatal: '致命',
  warn: '警告',
  warning: '警告',
  info: '資訊',
};

export function sevLabel(sev: string | null): string {
  if (!sev) return '—';
  return SEV_LABEL[sev.toLowerCase()] || sev;
}

// 完全相符的固定訊息
const EXACT: Record<string, string> = {
  approved: '已核可',
  'delivered to edge': '已派送至 Edge',
  'device soft-deleted': '設備已軟刪除',
  'device updated': '設備已更新',
  'ecsu deleted': 'ECSU 已刪除',
  'entered maintenance': '進入維護模式',
  'placeholder device created (wizard bootstrap)': '已建立佔位設備（Wizard 初始化）',
  'resumed from maintenance': '已從維護模式恢復',
  'token issued after approval': '核可後已發出 token',
  'token re-issued (Edge re-enroll with matching fingerprint)':
    'token 已重發（Edge re-enroll，fingerprint 相符）',
  'edge hostname renamed': 'Edge hostname 已更名',
};

/**
 * 將 ems_events.message 轉成繁中描述（保留專有名詞）。
 * 未知樣式回原文。
 */
export function humanizeMessage(msg: string | null): string {
  if (!msg) return '—';
  if (EXACT[msg]) return EXACT[msg];

  let r: RegExpMatchArray | null;
  if ((r = msg.match(/^command created: (.+)$/))) return `已建立指令：${r[1]}`;
  if ((r = msg.match(/^config ack: (\S+) v(\d+)$/))) return `設定回報：${r[1]} v${r[2]}`;
  if ((r = msg.match(/^device created: (.+)$/))) return `已建立設備：${r[1]}`;
  if ((r = msg.match(/^report: (\S+)(?: err=(.+))?$/)))
    return `指令回報：${r[1]}${r[2] ? `，錯誤=${r[2]}` : ''}`;
  if ((r = msg.match(/^revoked: (.*)$/))) return `已撤銷：${r[1] || '（未填原因）'}`;
  if ((r = msg.match(/^enroll request status=(.+)$/))) return `註冊請求 status=${r[1]}`;
  if ((r = msg.match(/^batch cleanup placeholders: deleted (\d+) row\(s\)$/)))
    return `批次清理佔位設備：已刪除 ${r[1]} 筆`;
  if ((r = msg.match(/^IR device archived[^:]*:\s*(.+)$/)))
    return `IR 設備已封存（拆除設備列表隱藏）：${r[1]}`;

  // 前綴替換（保留後段專有名詞）
  if (msg.startsWith('ecsu circuit bound:'))
    return msg.replace('ecsu circuit bound:', 'ECSU 迴路已綁定：');
  if (msg.startsWith('ecsu circuit unbound:'))
    return msg.replace('ecsu circuit unbound:', 'ECSU 迴路已解綁：');
  if (msg.startsWith('ecsu circuit updated:'))
    return msg.replace('ecsu circuit updated:', 'ECSU 迴路已更新：');
  if (msg.startsWith('ecsu updated:')) return msg.replace('ecsu updated:', 'ECSU 已更新：');
  if (msg.startsWith('edge updated:')) return msg.replace('edge updated:', 'Edge 已更新：');

  // 告警類「{rule} triggered」（rule_name 常已中文）
  if ((r = msg.match(/^(.+) triggered$/))) return `${r[1]} 觸發`;

  return msg; // 未知樣式：保留原文
}
