/**
 * 遠端 I/O 監控頁（M-PM-240 Phase A mock）
 *
 * 依託 vault SSOT v1.0 [[01_Edge/遠端IO_腳位功能模板_TCS300B03_TCS300B04]]
 *
 * 範圍：
 * - 6 場域 tab（Aa/Ab/Ae/Ba/Bc/C）
 * - 每場域 FanGrid（負壓 + 內循環；對齊各場域實際數量）
 * - 5 狀態 UI（vault §4.5.4：auto/manual/stop/overload/running）
 * - DO 啟動/停止 confirm dialog（v1.4 §61 二次確認）
 * - alarm panel + ack dialog（manual reset；reason + note）
 *
 * Phase A：mock data fallback；Phase B（M-PM-242 backend ready）切 real API
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  App,
  Badge,
  Button,
  Card,
  Col,
  Empty,
  Form,
  Input,
  Row,
  Select,
  Space,
  Spin,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import {
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  StopOutlined,
  ThunderboltOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { SITE_CONFIGS, deriveFanMode, type FanType, type SiteConfig } from '../constants/remoteIO';
import {
  USE_MOCK_DATA,
  useAckAlarm,
  useActiveAlarms,
  useDOControl,
  useFanStatus,
  type ActiveAlarm,
  type AckAlarmBody,
} from '../hooks/useRemoteIO';

const { Title, Text } = Typography;

// ─────────────────────────────────────────────────────────────
// FanCard — 單一風扇 5 狀態 UI + DO 控制
// ─────────────────────────────────────────────────────────────

interface FanCardProps {
  site: SiteConfig;
  fan_type: FanType;
  fan_index: number;
}

function FanCard({ site, fan_type, fan_index }: FanCardProps) {
  const { message, modal } = App.useApp();
  const { data: status, isLoading } = useFanStatus(site.edge_id, fan_type, fan_index);
  const doControl = useDOControl();

  const fan_name = fan_type === 'fugu' ? `負壓風扇 ${fan_index}` : `內循環風扇 ${fan_index}`;
  const mode = status ? deriveFanMode(status) : null;

  const handleDOControl = (new_state: boolean) => {
    const action = new_state ? '啟動' : '停止';
    modal.confirm({
      title: `${action} ${fan_name}`,
      icon: <ExclamationCircleOutlined style={{ color: '#1677ff' }} />,
      width: 460,
      content: (
        <div>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message={`${site.name} - ${fan_name}`}
            description={`Edge: ${site.edge_id} / DO 通道將${action}（自動起動 relay）`}
          />
          <Text type="secondary" style={{ fontSize: 12 }}>
            ⚠️ 二次確認危險操作（v1.4 §61）
          </Text>
        </div>
      ),
      okText: `確認${action}`,
      cancelText: '取消',
      okButtonProps: { danger: !new_state, type: new_state ? 'primary' : 'default' },
      onOk: async () => {
        try {
          await doControl.mutateAsync({
            edge_id: site.edge_id,
            fan_type,
            fan_index,
            new_state,
          });
          message.success(`${fan_name} ${action}指令已下發`);
        } catch (err) {
          message.error(`${action}失敗：${(err as Error).message}`);
          throw err;
        }
      },
    });
  };

  const cardBorderColor = useMemo(() => {
    if (!mode) return undefined;
    switch (mode) {
      case 'overload':
        return '#ff4d4f';
      case 'auto':
        return '#52c41a';
      case 'manual':
        return '#bfbfbf';
      case 'stop':
        return '#d9d9d9';
    }
  }, [mode]);

  if (isLoading || !status) {
    return (
      <Card size="small" style={{ minHeight: 180 }}>
        <Spin />
      </Card>
    );
  }

  const ModeIcon = mode === 'overload'
    ? WarningOutlined
    : mode === 'auto'
      ? PlayCircleOutlined
      : mode === 'manual'
        ? PauseCircleOutlined
        : StopOutlined;

  return (
    <Card
      size="small"
      style={{ borderColor: cardBorderColor, borderWidth: 2 }}
      title={
        <Space size={6}>
          <Text strong>{fan_name}</Text>
        </Space>
      }
      extra={
        <ModeIcon
          style={{
            color: cardBorderColor,
            fontSize: 18,
          }}
        />
      }
    >
      {/* DI 4 signal indicators */}
      <Space direction="vertical" size={4} style={{ width: '100%' }}>
        <Space size={4} wrap>
          <Tag color={status.manual ? 'default' : 'gray'} icon={status.manual ? <CheckCircleOutlined /> : undefined}>
            手動 {status.manual ? '●' : '○'}
          </Tag>
          <Tag color={status.auto ? 'green' : 'gray'} icon={status.auto ? <CheckCircleOutlined /> : undefined}>
            自動 {status.auto ? '●' : '○'}
          </Tag>
        </Space>
        <Space size={4} wrap>
          <Tag color={status.running ? 'blue' : 'gray'}>
            運轉 {status.running ? '●' : '○'}
          </Tag>
          <Tag color={status.overload ? 'red' : 'gray'}>
            過載 {status.overload ? '⚠' : '○'}
          </Tag>
        </Space>

        {/* Mode display */}
        <div style={{ marginTop: 8, marginBottom: 8 }}>
          {mode === 'auto' && (
            <Text style={{ color: '#52c41a', fontWeight: 600 }}>
              ✅ 自動模式{status.running ? '（運轉中）' : '（待機）'}
            </Text>
          )}
          {mode === 'manual' && (
            <Text type="secondary" style={{ fontWeight: 600 }}>
              🔒 實體手動模式（不可遙控）
            </Text>
          )}
          {mode === 'stop' && (
            <Text type="secondary">⏸️ 停止 / 未啟用</Text>
          )}
          {mode === 'overload' && (
            <Text style={{ color: '#ff4d4f', fontWeight: 600 }}>
              🚨 過載警示
            </Text>
          )}
        </div>

        {/* DO button */}
        {mode === 'overload' && (
          <Button danger block disabled icon={<WarningOutlined />}>
            過載；禁止啟動
          </Button>
        )}
        {mode === 'manual' && (
          <Button block disabled>
            實體手動模式（不可操作）
          </Button>
        )}
        {mode === 'stop' && (
          <Button block disabled>
            實體切到停止位置
          </Button>
        )}
        {mode === 'auto' && !status.running && (
          <Button
            type="primary"
            block
            icon={<PlayCircleOutlined />}
            loading={doControl.isPending}
            onClick={() => handleDOControl(true)}
          >
            啟動
          </Button>
        )}
        {mode === 'auto' && status.running && (
          <Button
            danger
            block
            icon={<StopOutlined />}
            loading={doControl.isPending}
            onClick={() => handleDOControl(false)}
          >
            停止
          </Button>
        )}
      </Space>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────
// FanGrid — 場域風扇 grid
// ─────────────────────────────────────────────────────────────

function FanGrid({ site }: { site: SiteConfig }) {
  return (
    <div>
      {site.fugu_count > 0 && (
        <>
          <Title level={5} style={{ marginTop: 0 }}>
            負壓大型風扇（{site.fugu_count} 顆）
          </Title>
          <Row gutter={[12, 12]}>
            {Array.from({ length: site.fugu_count }).map((_, i) => (
              <Col key={`fugu-${i + 1}`} xs={24} sm={12} md={8} lg={6}>
                <FanCard site={site} fan_type="fugu" fan_index={i + 1} />
              </Col>
            ))}
          </Row>
        </>
      )}
      {site.xun_count > 0 && (
        <>
          <Title level={5} style={{ marginTop: 24 }}>
            內循環風扇（{site.xun_count} 組）
          </Title>
          <Row gutter={[12, 12]}>
            {Array.from({ length: site.xun_count }).map((_, i) => (
              <Col key={`xun-${i + 1}`} xs={24} sm={12} md={8} lg={6}>
                <FanCard site={site} fan_type="xun" fan_index={i + 1} />
              </Col>
            ))}
          </Row>
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// AlarmPanel — 頂部固定 alarm panel + ack dialog
// ─────────────────────────────────────────────────────────────

function AlarmPanel() {
  const { data: alarms } = useActiveAlarms();
  const ackAlarm = useAckAlarm();
  const { message, modal } = App.useApp();
  const [ackForm] = Form.useForm<AckAlarmBody>();

  const openAckDialog = (alarm: ActiveAlarm) => {
    ackForm.resetFields();
    ackForm.setFieldsValue({ alarm_id: alarm.alarm_id, reason: 'reset_relay', note: '' });
    modal.confirm({
      title: `🚨 確認警報 — ${alarm.fan_name}`,
      icon: <WarningOutlined style={{ color: '#ff4d4f' }} />,
      width: 500,
      content: (
        <div>
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 12 }}
            message={`${alarm.site_code} / ${alarm.fan_name} 過載`}
            description={`Edge: ${alarm.edge_id} / 觸發時間: ${new Date(alarm.triggered_at).toLocaleString('zh-TW')}`}
          />
          <Form form={ackForm} layout="vertical" preserve={false}>
            <Form.Item name="reason" label="處理過載原因" rules={[{ required: true }]}>
              <Select
                options={[
                  { value: 'reset_relay', label: '重設 OL relay' },
                  { value: 'checked', label: '已檢查設備' },
                  { value: 'other', label: '其他' },
                ]}
              />
            </Form.Item>
            <Form.Item name="note" label="備註（選填）">
              <Input.TextArea rows={2} placeholder="可選；例：實體 OL relay 已 reset 並確認運轉" />
            </Form.Item>
          </Form>
        </div>
      ),
      okText: '確認 ack 警報',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          const body = await ackForm.validateFields();
          await ackAlarm.mutateAsync({ ...body, alarm_id: alarm.alarm_id });
          message.success(`警報 ${alarm.fan_name} 已 ack`);
        } catch (err) {
          message.error(`ack 失敗：${(err as Error).message ?? '驗證失敗'}`);
          throw err;
        }
      },
    });
  };

  if (!alarms || alarms.length === 0) {
    return null;
  }

  return (
    <Alert
      type="error"
      showIcon
      style={{ marginBottom: 16 }}
      message={`${alarms.length} 個 active 過載警報`}
      description={
        <Space direction="vertical" size={4} style={{ width: '100%' }}>
          {alarms.map((alarm) => (
            <Space key={alarm.alarm_id} size={8} wrap>
              <Tag color="red" icon={<WarningOutlined />}>
                {alarm.site_code} / {alarm.fan_name}
              </Tag>
              <Text type="secondary" style={{ fontSize: 12 }}>
                Edge: {alarm.edge_id} · 觸發於 {new Date(alarm.triggered_at).toLocaleString('zh-TW')}
              </Text>
              <Button size="small" danger onClick={() => openAckDialog(alarm)}>
                確認警報
              </Button>
            </Space>
          ))}
        </Space>
      }
    />
  );
}

// ─────────────────────────────────────────────────────────────
// Main page
// ─────────────────────────────────────────────────────────────

export default function RemoteIO() {
  const [activeSite, setActiveSite] = useState<SiteConfig['code']>('Aa');

  return (
    <div>
      <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 16 }} align="start">
        <div>
          <Title level={3} style={{ margin: 0 }}>
            <ThunderboltOutlined /> 遠端 I/O 監控
          </Title>
          <Text type="secondary">
            6 場域 × 9 風扇（最大）；4 DI（手動/自動/運轉/過載）+ 1 DO（自動起動）；對齊 vault SSOT v1.0
          </Text>
        </div>
        {USE_MOCK_DATA && (
          <Badge.Ribbon text="MOCK 階段" color="orange">
            <div style={{ width: 100, height: 1 }} />
          </Badge.Ribbon>
        )}
      </Space>

      {USE_MOCK_DATA && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="MOCK Data 階段（M-PM-240 Phase A）"
          description="本頁為 mock data 階段；UI / dialog flow / state 邏輯展示；backend API（M-PM-242）ready 後切真實資料。風扇狀態為 deterministic mock；點啟動/停止不會真實控制硬體。"
        />
      )}

      <AlarmPanel />

      <Tabs
        activeKey={activeSite}
        onChange={(k) => setActiveSite(k as SiteConfig['code'])}
        items={SITE_CONFIGS.map((site) => ({
          key: site.code,
          label: (
            <Space size={4}>
              <Text strong>{site.name}</Text>
              <Text type="secondary" style={{ fontSize: 11 }}>
                ({site.fugu_count}+{site.xun_count})
              </Text>
              {site.is_max && <Tag color="blue" style={{ marginLeft: 2, fontSize: 10 }}>MAX</Tag>}
            </Space>
          ),
          children: <FanGridWithSite site={site} />,
        }))}
      />
    </div>
  );
}

function FanGridWithSite({ site }: { site: SiteConfig }) {
  if (site.fugu_count + site.xun_count === 0) {
    return <Empty description="場域無風扇配置" />;
  }
  return (
    <div>
      <Space direction="vertical" size={4} style={{ marginBottom: 12 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          Edge: <Text code>{site.edge_id}</Text> · LAN: <Text code>{site.edge_lan_ip}</Text>
        </Text>
      </Space>
      <FanGrid site={site} />
    </div>
  );
}
