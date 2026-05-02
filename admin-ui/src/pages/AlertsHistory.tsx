/**
 * 異常履歷 Tab — T-S11C-002 Phase γ/δ（M-PM-088 §2.1 採納）
 *
 * 對接 P12 GET /v1/alerts/history（M-P12-024 §六）；嵌入 Reports.tsx 作為 Tab。
 *
 * 設計：
 * - filter: severity / event_type / 時間區間 / device 範圍（IR / Edge / 全部）
 * - row click → detail Modal 顯示完整事件 + 811C LED 燈號對照表（Phase δ-2；ADR-028 §8.4）
 * - device_id 顯示優先用 IR display_name（從 useIrDevices() JOIN）
 * - active alert 列可一鍵 ack（PUT /v1/alerts/{id}/ack；idempotent；M-P12-024 §6.4）
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  DatePicker,
  Descriptions,
  Empty,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from 'antd';
import { CheckCircleOutlined, ReloadOutlined, BulbOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { Dayjs } from 'dayjs';
import {
  useActiveAlerts,
  useAlertHistory,
  useAckAlert,
  severityColor,
  severityLabel,
  eventTypeColor,
  eventTypeLabel,
  type AlertActive,
  type AlertHistoryEvent,
  type AlertSeverity,
  type AlertEventType,
} from '../hooks/useAlerts';
import { useIrDevices } from '../hooks/useIrDevices';

const { Text } = Typography;
const { RangePicker } = DatePicker;

const SEVERITY_OPTIONS = [
  { value: 'critical', label: '危險 critical' },
  { value: 'warning', label: '警告 warning' },
  { value: 'info', label: '注意 info' },
];

const EVENT_TYPE_OPTIONS = [
  { value: 'triggered', label: '觸發 triggered' },
  { value: 'acknowledged', label: '已確認 acknowledged' },
  { value: 'auto_resolved', label: '自動恢復 auto_resolved' },
  { value: 'cleared', label: '已清除 cleared' },
  { value: 'escalated', label: '升級 escalated' },
  { value: 'suppressed_by_edge_down', label: 'Edge 抑制 suppressed_by_edge_down' },
];

/** 設備範圍 filter — 直接對 device_id prefix 過濾（前端側；後端不另開 endpoint）*/
type DeviceScope = 'all' | 'ir' | 'edge_only';

/**
 * 811C LED 燈號對照表（Phase δ-2；ADR-028 §8.4 + 811C_硬體規格手冊）
 * 提供現場排障輔助 — 維運到設備旁觀察 PWR / ST 即可 1 秒判讀。
 */
const LED_HINT_ROWS = [
  {
    pwr: '長亮',
    st: '長滅',
    description: '通電中但未連線（多半是網路/Edge 問題）',
    related: 'L1 IR 設備離線 / E1 Edge 失聯',
  },
  {
    pwr: '長亮',
    st: '長亮',
    description: '連線建立但未推送（多半是 Edge 接收端拒絕 / port 設定錯）',
    related: 'L2 IR 推送頻率異常（參 4/17 紀錄 port 80→8080 坑）',
  },
  {
    pwr: '快閃 (0.05s)',
    st: '長亮',
    description: '正常數據傳輸中（MTCP 系列）',
    related: '無告警；正常運作',
  },
  {
    pwr: '快閃 (0.05s)',
    st: '慢閃 (0.5s)',
    description: '數據傳輸中但溫度判斷異常（MTCP 系列）',
    related: 'L3 IR 資料異常',
  },
  {
    pwr: '長亮',
    st: '慢閃 (0.5s)',
    description: '溫度判斷異常但未推送（hardware 級，現場處理）',
    related: 'L3 IR 資料異常 + L2 推送頻率異常並發',
  },
  {
    pwr: '慢閃 (0.5s)',
    st: '慢閃 (0.5s)',
    description: 'eSearch 定位功能（MTCP 系列；非異常）',
    related: '維運操作中；非告警',
  },
];

interface DetailRow {
  type: 'active' | 'history';
  data: AlertActive | AlertHistoryEvent;
}

/** Thermal Tab 內嵌使用；不獨立路由 */
export default function AlertsHistory() {
  const [scope, setScope] = useState<DeviceScope>('ir');
  const [severity, setSeverity] = useState<AlertSeverity | undefined>();
  const [eventType, setEventType] = useState<AlertEventType | undefined>();
  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs().subtract(7, 'day'), dayjs()]);
  const [limit, setLimit] = useState<number>(200);
  const [detail, setDetail] = useState<DetailRow | null>(null);
  const [ackingId, setAckingId] = useState<number | null>(null);
  const [ackForm] = Form.useForm<{ acked_by: string; ack_note: string }>();

  // active alerts（30s polling；本頁也用以決定 row「可 ack」）
  const { data: activeData, isLoading: activeLoading, refetch: refetchActive } = useActiveAlerts(
    severity ? { severity } : {},
  );
  const activeAlerts: AlertActive[] = activeData ?? [];

  // history（依 filter 撈）
  const historyFilter = useMemo(
    () => ({
      severity,
      event_type: eventType,
      since: range[0].toISOString(),
      until: range[1].toISOString(),
      limit,
    }),
    [severity, eventType, range, limit],
  );
  const {
    data: historyData,
    isLoading: historyLoading,
    refetch: refetchHistory,
  } = useAlertHistory(historyFilter);
  const allHistory: AlertHistoryEvent[] = historyData ?? [];

  // IR display_name 對照（從 useIrDevices hook；缺值 fallback device_id）
  const { data: irDevicesData } = useIrDevices();
  const irNameMap = useMemo(() => {
    const m = new Map<string, string>();
    (irDevicesData ?? []).forEach((d) => {
      if (d.display_name) m.set(d.device_id, d.display_name);
    });
    return m;
  }, [irDevicesData]);

  // rule_id → rule_name 對照（history endpoint 不回 rule_name；用 active 反查）
  // 限制：rule 從未 active 過則 fallback 顯示 rule_id；可接受
  const ruleNameMap = useMemo(() => {
    const m = new Map<number, string>();
    activeAlerts.forEach((a) => m.set(a.rule_id, a.rule_name));
    return m;
  }, [activeAlerts]);
  const ruleLabel = (rule_id: number) =>
    ruleNameMap.get(rule_id) ?? `規則 #${rule_id}`;

  const ackMutation = useAckAlert();

  // 按 scope 過濾（前端側；後端 endpoint 已支援 device_id/edge_id 但 IR 群組需 prefix）
  const filteredActive = useMemo(() => {
    if (scope === 'all') return activeAlerts;
    if (scope === 'edge_only') return activeAlerts.filter((a) => a.scope === 'edge');
    // ir
    return activeAlerts.filter((a) => (a.device_id ?? '').startsWith('811c_'));
  }, [activeAlerts, scope]);

  const filteredHistory = useMemo(() => {
    if (scope === 'all') return allHistory;
    if (scope === 'edge_only') return allHistory.filter((h) => !h.device_id);
    // ir
    return allHistory.filter((h) => (h.device_id ?? '').startsWith('811c_'));
  }, [allHistory, scope]);

  const renderDeviceCell = (deviceId: string | null, edgeId: string | null) => {
    if (!deviceId && edgeId) {
      return <Tag color="purple">Edge · {edgeId}</Tag>;
    }
    if (!deviceId) {
      return <Text type="secondary">—</Text>;
    }
    const display = irNameMap.get(deviceId);
    return (
      <Space direction="vertical" size={0}>
        {display ? <Text strong>{display}</Text> : <Text type="secondary">未命名</Text>}
        <Text type="secondary" style={{ fontSize: 11, fontFamily: 'monospace' }}>
          {deviceId}
        </Text>
      </Space>
    );
  };

  const handleAck = async () => {
    if (ackingId == null) return;
    try {
      const values = await ackForm.validateFields();
      await ackMutation.mutateAsync({
        alert_id: ackingId,
        body: { acked_by: values.acked_by.trim(), ack_note: values.ack_note?.trim() || undefined },
      });
      message.success('告警已確認');
      setAckingId(null);
      ackForm.resetFields();
    } catch (e: any) {
      if (e?.errorFields) return;
      message.error(`確認失敗：${e?.response?.data?.detail ?? e?.message ?? '未知錯誤'}`);
    }
  };

  const activeColumns: ColumnsType<AlertActive> = [
    {
      title: '觸發時間',
      dataIndex: 'triggered_at',
      key: 'triggered_at',
      width: 170,
      render: (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm:ss'),
    },
    {
      title: '嚴重度',
      dataIndex: 'severity',
      key: 'severity',
      width: 100,
      render: (v: AlertSeverity) => <Tag color={severityColor(v)}>{severityLabel(v)} · {v}</Tag>,
    },
    {
      title: '規則',
      dataIndex: 'rule_name',
      key: 'rule_name',
      width: 180,
      render: (v: string, rec) => (
        <Space direction="vertical" size={0}>
          <Text>{v}</Text>
          <Text type="secondary" style={{ fontSize: 11 }}>
            {rec.scope} · {rec.category}
          </Text>
        </Space>
      ),
    },
    {
      title: '目標',
      key: 'target',
      width: 240,
      render: (_, rec) => renderDeviceCell(rec.device_id, rec.edge_id),
    },
    {
      title: '訊息',
      dataIndex: 'message',
      key: 'message',
      ellipsis: true,
    },
    {
      title: '狀態',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (v: string, rec) =>
        v === 'acknowledged' ? (
          <Tag color="blue">已確認 · {rec.acked_by ?? ''}</Tag>
        ) : (
          <Tag color="red">未確認</Tag>
        ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 160,
      render: (_, rec) => (
        <Space>
          <Button size="small" onClick={() => setDetail({ type: 'active', data: rec })}>
            詳情
          </Button>
          {rec.status === 'active' && (
            <Button
              size="small"
              type="primary"
              icon={<CheckCircleOutlined />}
              onClick={() => {
                setAckingId(rec.alert_id);
                ackForm.setFieldsValue({ acked_by: '老王', ack_note: '' });
              }}
            >
              確認
            </Button>
          )}
        </Space>
      ),
    },
  ];

  const historyColumns: ColumnsType<AlertHistoryEvent> = [
    {
      title: '時間',
      dataIndex: 'ts',
      key: 'ts',
      width: 170,
      render: (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm:ss'),
    },
    {
      title: '事件',
      dataIndex: 'event_type',
      key: 'event_type',
      width: 160,
      render: (v: AlertEventType) => <Tag color={eventTypeColor(v)}>{eventTypeLabel(v)}</Tag>,
    },
    {
      title: '嚴重度',
      dataIndex: 'severity',
      key: 'severity',
      width: 100,
      render: (v: AlertSeverity) => <Tag color={severityColor(v)}>{severityLabel(v)}</Tag>,
    },
    {
      title: '規則',
      key: 'rule',
      width: 180,
      render: (_, rec) => ruleLabel(rec.rule_id),
    },
    {
      title: '目標',
      key: 'target',
      width: 240,
      render: (_, rec) => renderDeviceCell(rec.device_id, rec.edge_id),
    },
    {
      title: '訊息 / actor',
      key: 'msg',
      ellipsis: true,
      render: (_, rec) => (
        <Space direction="vertical" size={0} style={{ width: '100%' }}>
          <Text style={{ fontSize: 12 }} ellipsis>
            {rec.message ?? '—'}
          </Text>
          {rec.actor && (
            <Text type="secondary" style={{ fontSize: 11 }}>
              actor: {rec.actor}
            </Text>
          )}
        </Space>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 80,
      render: (_, rec) => (
        <Button size="small" onClick={() => setDetail({ type: 'history', data: rec })}>
          詳情
        </Button>
      ),
    },
  ];

  const renderFilters = () => (
    <Space wrap style={{ marginBottom: 16 }}>
      <Select
        style={{ width: 140 }}
        value={scope}
        onChange={setScope}
        options={[
          { value: 'ir', label: 'IR 設備' },
          { value: 'edge_only', label: 'Edge 主機' },
          { value: 'all', label: '全部' },
        ]}
      />
      <Select
        allowClear
        style={{ width: 160 }}
        placeholder="嚴重度"
        value={severity}
        onChange={setSeverity}
        options={SEVERITY_OPTIONS}
      />
      <Select
        allowClear
        style={{ width: 220 }}
        placeholder="事件類型（僅履歷）"
        value={eventType}
        onChange={setEventType}
        options={EVENT_TYPE_OPTIONS}
      />
      <RangePicker
        showTime
        value={range}
        onChange={(v) => v && v[0] && v[1] && setRange([v[0], v[1]])}
      />
      <Select
        style={{ width: 130 }}
        value={limit}
        onChange={setLimit}
        options={[
          { value: 50, label: 'limit 50' },
          { value: 200, label: 'limit 200' },
          { value: 500, label: 'limit 500' },
          { value: 1000, label: 'limit 1000' },
        ]}
      />
      <Button
        icon={<ReloadOutlined />}
        onClick={() => {
          refetchActive();
          refetchHistory();
        }}
      >
        重新載入
      </Button>
    </Space>
  );

  return (
    <>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="即時 active 異常每 30 秒自動更新；履歷依 filter 條件查詢（最大 limit=1000）"
        description="點「詳情」查看完整事件資料 + 現場 LED 排障 hint（適用 811C IR 設備）"
      />
      {renderFilters()}
      <Tabs
        defaultActiveKey="active"
        items={[
          {
            key: 'active',
            label: `當前異常（${filteredActive.length}）`,
            children: (
              <Card size="small">
                {activeLoading ? (
                  <div style={{ textAlign: 'center', padding: 60 }}>
                    <Spin />
                  </div>
                ) : filteredActive.length === 0 ? (
                  <Empty description="目前無 active 異常" />
                ) : (
                  <Table<AlertActive>
                    columns={activeColumns}
                    dataSource={filteredActive}
                    rowKey="alert_id"
                    size="small"
                    pagination={{ pageSize: 20 }}
                  />
                )}
              </Card>
            ),
          },
          {
            key: 'history',
            label: `事件履歷（${filteredHistory.length}）`,
            children: (
              <Card size="small">
                {historyLoading ? (
                  <div style={{ textAlign: 'center', padding: 60 }}>
                    <Spin />
                  </div>
                ) : filteredHistory.length === 0 ? (
                  <Empty description="時段內無履歷事件" />
                ) : (
                  <Table<AlertHistoryEvent>
                    columns={historyColumns}
                    dataSource={filteredHistory}
                    rowKey={(r) => `${r.ts}-${r.alert_id ?? 'noalert'}-${r.event_type}-${r.rule_id}`}
                    size="small"
                    pagination={{ pageSize: 20 }}
                  />
                )}
              </Card>
            ),
          },
        ]}
      />

      {/* 詳情 Modal — 含 LED 燈號對照表（Phase δ-2；ADR-028 §8.4）*/}
      <Modal
        title="異常事件詳情"
        open={!!detail}
        onCancel={() => setDetail(null)}
        width={760}
        footer={[
          <Button key="close" onClick={() => setDetail(null)}>
            關閉
          </Button>,
        ]}
        destroyOnHidden
      >
        {detail && detail.type === 'active' && (
          <ActiveDetailPanel data={detail.data as AlertActive} />
        )}
        {detail && detail.type === 'history' && (
          <HistoryDetailPanel data={detail.data as AlertHistoryEvent} ruleLabel={ruleLabel} />
        )}
        {detail && (detail.data.device_id ?? '').startsWith('811c_') && <LedHintPanel />}
      </Modal>

      {/* Ack Modal */}
      <Modal
        title="確認異常告警"
        open={ackingId != null}
        onOk={handleAck}
        onCancel={() => {
          setAckingId(null);
          ackForm.resetFields();
        }}
        okText="送出確認"
        cancelText="取消"
        confirmLoading={ackMutation.isPending}
        destroyOnHidden
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="確認後告警 status 將改為 acknowledged；不會自動清除（需 worker 自動恢復或人工 cleared）"
          description="同 alert 重複確認回 200 idempotent（不重複入 history）"
        />
        <Form form={ackForm} layout="vertical">
          <Form.Item
            name="acked_by"
            label="確認人"
            rules={[
              { required: true, message: '請輸入確認人' },
              { max: 50, message: '不超過 50 字' },
            ]}
          >
            <Input placeholder="例：老王 / 維運 A 班" />
          </Form.Item>
          <Form.Item name="ack_note" label="備註（選填）" rules={[{ max: 500, message: '不超過 500 字' }]}>
            <Input.TextArea rows={3} placeholder="例：已通知現場維運；預計 11/3 下午前修復" />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}

function ActiveDetailPanel({ data }: { data: AlertActive }) {
  return (
    <Descriptions bordered column={1} size="small">
      <Descriptions.Item label="alert_id">{data.alert_id}</Descriptions.Item>
      <Descriptions.Item label="規則">
        {data.rule_name} (id={data.rule_id})
      </Descriptions.Item>
      <Descriptions.Item label="嚴重度 / 類別 / 範圍">
        <Space>
          <Tag color={severityColor(data.severity)}>{severityLabel(data.severity)} · {data.severity}</Tag>
          <Tag>{data.category}</Tag>
          <Tag>{data.scope}</Tag>
        </Space>
      </Descriptions.Item>
      <Descriptions.Item label="目標">
        {data.device_id && <div>device: {data.device_id}</div>}
        {data.edge_id && <div>edge: {data.edge_id}</div>}
      </Descriptions.Item>
      <Descriptions.Item label="觸發時間">
        {dayjs(data.triggered_at).format('YYYY-MM-DD HH:mm:ss')}
      </Descriptions.Item>
      <Descriptions.Item label="觸發值">
        {data.trigger_metric ?? '—'}: {data.trigger_value ?? '—'}
      </Descriptions.Item>
      <Descriptions.Item label="最近觀察">
        {data.last_seen_at ? dayjs(data.last_seen_at).format('YYYY-MM-DD HH:mm:ss') : '—'}（值：
        {data.last_value ?? '—'}）
      </Descriptions.Item>
      <Descriptions.Item label="訊息">{data.message}</Descriptions.Item>
      <Descriptions.Item label="狀態">
        {data.status === 'acknowledged' ? (
          <Space direction="vertical" size={0}>
            <Tag color="blue">已確認 · {data.acked_by ?? ''}</Tag>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {data.acked_at ? dayjs(data.acked_at).format('YYYY-MM-DD HH:mm:ss') : ''}
            </Text>
            {data.ack_note && <Text style={{ fontSize: 12 }}>備註：{data.ack_note}</Text>}
          </Space>
        ) : (
          <Tag color="red">未確認</Tag>
        )}
      </Descriptions.Item>
    </Descriptions>
  );
}

function HistoryDetailPanel({
  data,
  ruleLabel,
}: {
  data: AlertHistoryEvent;
  ruleLabel: (rule_id: number) => string;
}) {
  return (
    <Descriptions bordered column={1} size="small">
      <Descriptions.Item label="時間">
        {dayjs(data.ts).format('YYYY-MM-DD HH:mm:ss')}
      </Descriptions.Item>
      <Descriptions.Item label="事件">
        <Tag color={eventTypeColor(data.event_type)}>{eventTypeLabel(data.event_type)}</Tag>
      </Descriptions.Item>
      <Descriptions.Item label="alert_id">
        {data.alert_id === 0 ? <Text type="secondary">— (cross-cutting)</Text> : data.alert_id}
      </Descriptions.Item>
      <Descriptions.Item label="規則">
        {ruleLabel(data.rule_id)} (id={data.rule_id})
      </Descriptions.Item>
      <Descriptions.Item label="嚴重度">
        <Tag color={severityColor(data.severity)}>{severityLabel(data.severity)}</Tag>
      </Descriptions.Item>
      <Descriptions.Item label="目標">
        {data.device_id && <div>device: {data.device_id}</div>}
        {data.edge_id && <div>edge: {data.edge_id}</div>}
        {!data.device_id && !data.edge_id && '—'}
      </Descriptions.Item>
      <Descriptions.Item label="觸發值">{data.value ?? '—'}</Descriptions.Item>
      <Descriptions.Item label="訊息">{data.message ?? '—'}</Descriptions.Item>
      <Descriptions.Item label="actor / note">
        {data.actor ? (
          <Space direction="vertical" size={0}>
            <Text>actor: {data.actor}</Text>
            {data.note && <Text style={{ fontSize: 12 }}>{data.note}</Text>}
          </Space>
        ) : (
          '—'
        )}
      </Descriptions.Item>
    </Descriptions>
  );
}

/** Phase δ-2：811C LED 燈號 hint（ADR-028 §8.4）*/
function LedHintPanel() {
  return (
    <Card
      size="small"
      style={{ marginTop: 16 }}
      title={
        <Space>
          <BulbOutlined />
          <Text strong>現場排障輔助 — 811C 設備本體 LED 燈號對照</Text>
        </Space>
      }
    >
      <Alert
        type="info"
        showIcon
        message="請維運人員到設備旁觀察 PWR / ST 兩顆 LED，對照下表 1 秒判讀"
        style={{ marginBottom: 12 }}
      />
      <Table
        size="small"
        pagination={false}
        rowKey={(r) => `${r.pwr}-${r.st}`}
        dataSource={LED_HINT_ROWS}
        columns={[
          { title: 'PWR', dataIndex: 'pwr', key: 'pwr', width: 120 },
          { title: 'ST', dataIndex: 'st', key: 'st', width: 120 },
          { title: '描述', dataIndex: 'description', key: 'description' },
          { title: '對應規則', dataIndex: 'related', key: 'related', width: 220 },
        ]}
      />
    </Card>
  );
}
