/**
 * 遠端 I/O 監控頁（M-PM-280 Phase B 真資料整合）
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
 * Phase B：real backend API（M-P12-058 commit c49725e）
 * - DI 狀態：data_source=pending_ingest → FanCard 顯示「DI 待 ingest」+ 保留 DO 按鈕
 * - DO 控制：✅ 可用（命令入 ems_commands queue；Guard stub-pass）
 * - Alarm：✅ 可用
 */
import { useEffect, useMemo, useRef, useState } from 'react';
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
  Tooltip,
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
import { SITE_CONFIGS, deriveFanMode, getFanChannelMapping, type FanType, type SiteConfig } from '../constants/remoteIO';
import { useAuth } from '../lib/authContext';
import {
  USE_MOCK_DATA,
  useAckAlarm,
  useActiveAlarms,
  useDOControl,
  useDODeviceStatus,
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
  const { data: doStatus } = useDODeviceStatus(site.edge_id);
  const doControl = useDOControl();
  // 件1b（M-P12-120）：I/O 控制鈕 gate can_control_io（後端 control_do 已 enforce 403，此為防呆 UX）
  const { user: me } = useAuth();
  const canControlIo = !!me?.can_control_io;

  const mapping = getFanChannelMapping(fan_type, fan_index);
  const fan_name = fan_type === 'fugu' ? `負壓風扇 ${fan_index}` : `內循環風扇 ${fan_index}`;
  const mode = status ? deriveFanMode(status) : null;

  // 老王 2026-06-05 啟動狀態判斷：運轉與否看「DO 輸出」（指令真的下達），DI 運轉為輔助驗證。
  // do_state = 該風扇 DO channel 即時狀態（tcs300b04 slave4）。
  const do_state = doStatus ? (doStatus[mapping.do_channel] ?? false) : false;

  // 異常 = DO 已輸出(ON) 持續 >20s 但 DI 運轉仍 OFF → 設備未真實啟動。
  // 前端即時視覺（client 端 20s 計時）；後端 watcher 另生持久警報進 AlarmPanel。
  const ANOMALY_GRACE_MS = 20_000;
  const doOnSinceRef = useRef<number | null>(null);
  const prevAnomalyRef = useRef(false);
  useEffect(() => {
    if (do_state && doOnSinceRef.current === null) doOnSinceRef.current = Date.now();
    if (!do_state) doOnSinceRef.current = null;
  }, [do_state]);
  const startupAnomaly =
    do_state &&
    status != null &&
    !status.running &&
    doOnSinceRef.current != null &&
    Date.now() - doOnSinceRef.current > ANOMALY_GRACE_MS;
  useEffect(() => {
    if (startupAnomaly && !prevAnomalyRef.current) {
      message.warning(`${fan_name} 啟動異常：DO 已輸出但設備未運轉（DI 運轉未觸發）`, 6);
    }
    prevAnomalyRef.current = startupAnomaly;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startupAnomaly]);

  const handleDOControl = (new_state: boolean) => {
    if (!canControlIo) {
      message.warning('無 I/O 控制權，無法操作風扇（需現場操作員權限；若您應有權限請重新登入刷新）');
      return;
    }
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

  const modeBorderColor = useMemo(() => {
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
  // 啟動異常時卡片轉紅框（優先於 mode 色）
  const cardBorderColor = startupAnomaly ? '#ff4d4f' : modeBorderColor;

  if (isLoading) {
    return (
      <Card size="small" style={{ minHeight: 180 }}>
        <Spin />
      </Card>
    );
  }

  // status null/undefined：DI pending_ingest 或 API 尚未就緒
  // 維持與 Phase A 相同卡片結構：DI Tag 全灰（○）+ 待 ingest 說明 + 一顆啟動按鈕
  if (!status) {
    return (
      <Card
        size="small"
        style={{ borderColor: '#d9d9d9', borderWidth: 2 }}
        title={<Space size={6}><Text strong>{fan_name}</Text></Space>}
        extra={<StopOutlined style={{ color: '#d9d9d9', fontSize: 18 }} />}
      >
        <Space direction="vertical" size={4} style={{ width: '100%' }}>
          <Space size={4} wrap>
            <Tag color="default">手動 ○</Tag>
            <Tag color="default">自動 ○</Tag>
          </Space>
          <Space size={4} wrap>
            <Tag color="default">運轉 ○</Tag>
            <Tag color="default">過載 ○</Tag>
          </Space>
          <div style={{ marginTop: 8, marginBottom: 8 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>⏳ 等待即時 DI 資料（無法操作）</Text>
          </div>
          {/* 軌C（老王 2026-06-22「DI 沒上來就擋」）：無即時 DI 回授一律擋啟動，避免盲開風扇
              （DO 輸出但拿不到 DI 確認運轉/過載）。DI ingest 上來後自動恢復可操作。 */}
          <Tooltip title="DI 訊號未上報（等待即時資料）；無 DI 回授不可操作風扇">
            <Button
              type="primary"
              block
              icon={<PlayCircleOutlined />}
              disabled
              onClick={() => handleDOControl(true)}
            >
              啟動
            </Button>
          </Tooltip>
        </Space>
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
          <Tag color={status.running ? 'blue' : startupAnomaly ? 'red' : 'gray'}>
            運轉 {status.running ? '●' : startupAnomaly ? '✕' : '○'}
          </Tag>
          <Tag color={status.overload ? 'red' : 'gray'}>
            過載 {status.overload ? '⚠' : '○'}
          </Tag>
        </Space>

        {/* Mode display */}
        <div style={{ marginTop: 8, marginBottom: 8 }}>
          {mode === 'auto' && !startupAnomaly && (
            <Text style={{ color: '#52c41a', fontWeight: 600 }}>
              ✅ 自動模式{do_state ? '（運轉中）' : '（待機）'}
            </Text>
          )}
          {mode === 'auto' && startupAnomaly && (
            <Text style={{ color: '#ff4d4f', fontWeight: 600 }}>
              🚨 啟動異常：DO 已輸出，設備未運轉
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
        {mode === 'auto' && !do_state && (
          <Tooltip title={canControlIo ? '' : '無 I/O 控制權，無法操作風扇（需現場操作員權限；若您應有權限請重新登入刷新）'}>
            <Button
              type="primary"
              block
              icon={<PlayCircleOutlined />}
              loading={doControl.isPending}
              disabled={!canControlIo}
              onClick={() => handleDOControl(true)}
            >
              啟動
            </Button>
          </Tooltip>
        )}
        {mode === 'auto' && do_state && (
          <Tooltip title={canControlIo ? '' : '無 I/O 控制權，無法操作風扇（需現場操作員權限；若您應有權限請重新登入刷新）'}>
            <Button
              danger
              block
              icon={<StopOutlined />}
              loading={doControl.isPending}
              disabled={!canControlIo}
              onClick={() => handleDOControl(false)}
            >
              停止
            </Button>
          </Tooltip>
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
  // 件1b：ack 過載警報（reset OL relay）屬現場操作，gate can_control_io（viewer 唯讀）
  const { user: me } = useAuth();
  const canControlIo = !!me?.can_control_io;

  const openAckDialog = (alarm: ActiveAlarm) => {
    if (!canControlIo) {
      message.warning('無 I/O 控制權，無法處理警報（需現場操作員權限；若您應有權限請重新登入刷新）');
      return;
    }
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
              <Tooltip title={canControlIo ? '' : '無 I/O 控制權，無法處理警報（若您應有權限請重新登入刷新）'}>
                <Button size="small" danger disabled={!canControlIo} onClick={() => openAckDialog(alarm)}>
                  確認警報
                </Button>
              </Tooltip>
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
  const [activeSite, setActiveSite] = useState<SiteConfig['code']>('A3'); // M-P12-079 預設首區（舊 'Aa'）

  return (
    <div>
      <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 16 }} align="start">
        <div>
          <Title level={3} style={{ margin: 0 }}>
            <ThunderboltOutlined /> 遠端 I/O 操作
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
