import { Drawer, Tabs, Descriptions, Timeline, Badge, Empty, Alert, Button, Space, Typography, Tag, App, Spin } from 'antd';
import { SyncOutlined, ClockCircleOutlined, CheckCircleOutlined, ExclamationCircleOutlined } from '@ant-design/icons';
import { StatusTag } from '../components/common/StatusTag';
import {
  useEdgeConfigSync,
  useEdgeEvents,
  useResyncEdge,
  type Edge,
  type EventItem,
} from '../hooks/useEdges';

const { Text } = Typography;

interface FingerprintHistoryEntry {
  fingerprint?: string;
  replaced_at?: string;
  replaced_by?: string;
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function parseFingerprintHistory(raw: unknown[]): FingerprintHistoryEntry[] {
  return raw.map((x): FingerprintHistoryEntry => {
    if (typeof x === 'string') return { fingerprint: x };
    if (x && typeof x === 'object') return x as FingerprintHistoryEntry;
    return {};
  });
}

function BasicTab({ edge }: { edge: Edge }) {
  return (
    <Descriptions column={1} bordered size="small" labelStyle={{ width: 140 }}>
      <Descriptions.Item label="Edge ID">{edge.edge_id}</Descriptions.Item>
      <Descriptions.Item label="名稱">{edge.edge_name ?? '—'}</Descriptions.Item>
      <Descriptions.Item label="狀態"><StatusTag status={edge.status} /></Descriptions.Item>
      <Descriptions.Item label="站點代碼">{edge.site_code ?? '—'}</Descriptions.Item>
      <Descriptions.Item label="主機名">{edge.hostname ?? '—'}</Descriptions.Item>
      <Descriptions.Item label="當前指紋">
        <Text code copyable={edge.fingerprint ? { text: edge.fingerprint } : undefined} style={{ fontSize: 12 }}>
          {edge.fingerprint ?? '尚未 enroll'}
        </Text>
      </Descriptions.Item>
      <Descriptions.Item label="最近 IP">{edge.last_seen_ip ?? '—'}</Descriptions.Item>
      <Descriptions.Item label="最近上線">{formatTime(edge.last_seen_at)}</Descriptions.Item>
      <Descriptions.Item label="config_version">{edge.config_version}</Descriptions.Item>
      <Descriptions.Item label="註冊時間">{formatTime(edge.registered_at)}</Descriptions.Item>
      <Descriptions.Item label="核可時間">{formatTime(edge.approved_at)}</Descriptions.Item>
      <Descriptions.Item label="核可人">{edge.approved_by ?? '—'}</Descriptions.Item>
      {edge.status === 'maintenance' && (
        <Descriptions.Item label="維護開始">{formatTime(edge.maintenance_at)}</Descriptions.Item>
      )}
      {edge.status === 'revoked' && (
        <>
          <Descriptions.Item label="撤銷時間">{formatTime(edge.revoked_at)}</Descriptions.Item>
          <Descriptions.Item label="撤銷原因">{edge.revoked_reason ?? '—'}</Descriptions.Item>
        </>
      )}
      {edge.remark_desc && <Descriptions.Item label="備註">{edge.remark_desc}</Descriptions.Item>}
    </Descriptions>
  );
}

function FingerprintTimelineTab({ edge }: { edge: Edge }) {
  const history = parseFingerprintHistory(edge.previous_fingerprints ?? []);
  const { data: events, isLoading } = useEdgeEvents(edge.edge_id, 'edge_lifecycle', 50);
  const lifecycleEvents = (events?.items ?? []).filter((e) => e.message?.toLowerCase().includes('fingerprint') || e.message?.toLowerCase().includes('enroll') || e.message?.toLowerCase().includes('replace'));

  const items: { color?: string; dot?: React.ReactNode; label?: React.ReactNode; children: React.ReactNode }[] = [];

  items.push({
    color: edge.status === 'pending_replace' ? 'red' : 'green',
    children: (
      <div>
        <Text strong>當前指紋</Text>
        <div><Text code style={{ fontSize: 12 }}>{edge.fingerprint ?? '（未 enroll）'}</Text></div>
        {edge.last_seen_at && <Text type="secondary">最近回報：{formatTime(edge.last_seen_at)}</Text>}
      </div>
    ),
  });

  history.forEach((entry, idx) => {
    items.push({
      color: 'gray',
      children: (
        <div>
          <Text>舊指紋 #{history.length - idx}</Text>
          <div><Text code style={{ fontSize: 12 }}>{entry.fingerprint ?? '—'}</Text></div>
          {entry.replaced_at && <Text type="secondary">換機時間：{formatTime(entry.replaced_at)}</Text>}
          {entry.replaced_by && <Text type="secondary" style={{ marginLeft: 12 }}>核可人：{entry.replaced_by}</Text>}
        </div>
      ),
    });
  });

  return (
    <div>
      {isLoading && <Spin />}
      {history.length === 0 && (
        <Alert type="info" showIcon message="尚無指紋換機歷史" description="只顯示目前指紋。當 Edge 硬體變更且管理員核可換機後，舊指紋會留在此處供稽核。" style={{ marginBottom: 16 }} />
      )}
      <Timeline items={items} />
      {lifecycleEvents.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <Text strong style={{ display: 'block', marginBottom: 8 }}>相關 edge_lifecycle 事件</Text>
          <Timeline
            items={lifecycleEvents.map((e) => ({
              color: e.severity === 'error' ? 'red' : e.severity === 'warn' ? 'orange' : 'blue',
              children: (
                <div>
                  <Text>{e.message ?? '(無訊息)'}</Text>
                  <div><Text type="secondary" style={{ fontSize: 12 }}>{formatTime(e.ts)} · {e.actor ?? '—'}</Text></div>
                </div>
              ),
            }))}
          />
        </div>
      )}
    </div>
  );
}

function ConfigSyncTab({ edge }: { edge: Edge }) {
  const { data, isLoading, error } = useEdgeConfigSync(edge.edge_id);
  const resync = useResyncEdge();
  const { message } = App.useApp();

  if (isLoading) return <Spin />;
  if (error) return <Alert type="error" showIcon message="讀取同步狀態失敗" description={(error as Error).message} />;
  if (!data) return <Empty description="無同步資料" />;

  const isStale = data.last_seen_at
    ? (Date.now() - new Date(data.last_seen_at).getTime()) > 5 * 60_000
    : true;

  const handleResync = async () => {
    try {
      const r = await resync.mutateAsync(edge.edge_id);
      message.success(`config_version 升至 ${r.new_version}，下次 Edge heartbeat 會拉新 config`);
    } catch (e) {
      message.error(`觸發失敗：${(e as Error).message}`);
    }
  };

  const syncAlert = (() => {
    if (isStale) {
      return <Alert type="error" showIcon icon={<ExclamationCircleOutlined />} message="Edge 超過 5 分鐘未回報" description={`可能已失聯。最近 heartbeat 時間：${formatTime(data.last_seen_at)}`} />;
    }
    if (data.is_synced) {
      return <Alert type="success" showIcon icon={<CheckCircleOutlined />} message="已同步" description={`DB 版本 = Edge 已套用版本 = ${data.db_version}`} />;
    }
    if (data.edge_applied_version === null) {
      return <Alert type="warning" showIcon message="尚未收到 config ack" description="Edge 還沒回報過 config 套用結果。可能是首次上線或尚未 pull config。" />;
    }
    return <Alert type="warning" showIcon icon={<ClockCircleOutlined />} message={`待同步（差 ${data.drift_count} 版）`} description={`DB 期望版本 ${data.db_version}，Edge 已套用 ${data.edge_applied_version}。下次 heartbeat 會自動拉取。`} />;
  })();

  return (
    <div>
      {syncAlert}
      <Descriptions column={1} bordered size="small" style={{ marginTop: 16 }} labelStyle={{ width: 180 }}>
        <Descriptions.Item label="DB 期望版本 (config_version)">
          <Badge count={data.db_version} showZero color="#1677ff" overflowCount={9999} />
        </Descriptions.Item>
        <Descriptions.Item label="Edge 已套用版本">
          {data.edge_applied_version === null
            ? <Text type="secondary">未回報</Text>
            : <Badge count={data.edge_applied_version} showZero color={data.is_synced ? '#52c41a' : '#faad14'} overflowCount={9999} />}
        </Descriptions.Item>
        <Descriptions.Item label="差異版本數">
          {data.drift_count === null
            ? <Text type="secondary">—</Text>
            : data.drift_count === 0
              ? <Tag color="green">同步</Tag>
              : <Tag color="orange">{data.drift_count}</Tag>}
        </Descriptions.Item>
        <Descriptions.Item label="最近 ack 時間">{formatTime(data.last_ack_at)}</Descriptions.Item>
        <Descriptions.Item label="最近 heartbeat 時間">{formatTime(data.last_seen_at)}</Descriptions.Item>
      </Descriptions>
      <Space style={{ marginTop: 16 }}>
        <Button
          type="primary"
          icon={<SyncOutlined />}
          onClick={handleResync}
          loading={resync.isPending}
          disabled={!(edge.status === 'approved' || edge.status === 'maintenance')}
        >
          強制重拉 config
        </Button>
        <Text type="secondary">bump config_version，下次 Edge heartbeat 會 diff 出差異並拉取</Text>
      </Space>
    </div>
  );
}

const SEVERITY_COLOR: Record<string, string> = {
  info: 'blue',
  warn: 'orange',
  error: 'red',
  critical: 'magenta',
};

function RecentEventsTab({ edge }: { edge: Edge }) {
  const { data, isLoading, error } = useEdgeEvents(edge.edge_id, undefined, 30);

  if (isLoading) return <Spin />;
  if (error) return <Alert type="error" showIcon message="讀取事件失敗" description={(error as Error).message} />;
  const items = data?.items ?? [];
  if (items.length === 0) return <Empty description="此 Edge 尚無事件記錄" />;

  return (
    <Timeline
      items={items.map((e: EventItem) => ({
        color: SEVERITY_COLOR[e.severity] ?? 'gray',
        children: (
          <div>
            <Space size={8}>
              <Tag color={SEVERITY_COLOR[e.severity] ?? 'default'}>{e.event_kind}</Tag>
              <Text type="secondary" style={{ fontSize: 12 }}>{e.severity}</Text>
            </Space>
            <div style={{ marginTop: 4 }}>{e.message ?? '(無訊息)'}</div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {formatTime(e.ts)}{e.actor ? ` · ${e.actor}` : ''}{e.device_id ? ` · device=${e.device_id}` : ''}
            </Text>
          </div>
        ),
      }))}
    />
  );
}

export function EdgeDrawer({ edge, open, onClose }: { edge: Edge | null; open: boolean; onClose: () => void }) {
  return (
    <Drawer
      title={edge ? `Edge：${edge.edge_id}` : 'Edge 詳情'}
      open={open}
      onClose={onClose}
      width={720}
      destroyOnHidden
    >
      {edge && (
        <Tabs
          defaultActiveKey="basic"
          items={[
            { key: 'basic', label: '基本資料', children: <BasicTab edge={edge} /> },
            { key: 'fingerprint', label: '指紋歷程', children: <FingerprintTimelineTab edge={edge} /> },
            { key: 'config-sync', label: 'Config 同步', children: <ConfigSyncTab edge={edge} /> },
            { key: 'events', label: '最近事件', children: <RecentEventsTab edge={edge} /> },
          ]}
        />
      )}
    </Drawer>
  );
}
