import { Tag } from 'antd';

type EdgeStatus = 'pending' | 'approved' | 'maintenance' | 'pending_replace' | 'revoked' | string;

const STATUS_MAP: Record<string, { color: string; label: string }> = {
  pending: { color: 'orange', label: '待核可' },
  approved: { color: 'green', label: '已核可' },
  maintenance: { color: 'blue', label: '維護中' },
  pending_replace: { color: 'red', label: '待核可換機' },
  revoked: { color: 'default', label: '已撤銷' },
};

export function StatusTag({ status }: { status: EdgeStatus }) {
  const meta = STATUS_MAP[status] ?? { color: 'default', label: status };
  return <Tag color={meta.color}>{meta.label}</Tag>;
}
