/**
 * ECSU 詳情頁（M-PM-220 T-AdminUI-010 §三）
 *
 * Schema 真實對齊 DB（M-PM-217 ground truth；去三段分區 / 去時間維度；用 sign +1/-1 + enabled）
 *
 * 範圍：
 * - 上半部基本資料（reuse Ecsu list row data；不另開 GET /{id}）
 * - 即時統計三 Card：即時 kW（30s refetch）/ 本月 kWh / 綁定數
 * - 編輯 ECSU 基本資料 Modal（reuse §二 form 6 欄）
 * - 下半部多對多綁定列表 + [+ 新增綁定] dialog 級聯 Edge→Device→Circuit
 *   - circuit_code 採自由輸入（M-PM-220 §三 自決 a；最簡業主可立即動）
 *   - sign 預設 +1（消耗）；可切 -1（反向潮流 / 太陽能反送）
 *   - enabled 預設 true
 * - 編輯綁定 dialog（只 sign / enabled / 備註；device_id + circuit_code 不可改）
 * - 移除綁定 Popconfirm
 *
 * 級聯下拉：Edge 列表（useEdges）+ Device per Edge filter（useEcsu list filter device_kind）
 */
import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Alert, Breadcrumb, Button, Card, Col, Descriptions, Form, Input, InputNumber,
  Modal, Popconfirm, Radio, Row, Select, Space, Spin, Statistic, Switch,
  Table, Tag, Typography, message,
} from 'antd';
import {
  ArrowLeftOutlined, EditOutlined, PlusOutlined, DeleteOutlined, ReloadOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import api from '../services/api';
import { useEdges } from '../hooks/useEdges';
import {
  useEcsuList,
  useEcsuCircuits,
  useEcsuRealtime,
  useEcsuMonthly,
  useUpdateEcsu,
  useCreateEcsuCircuit,
  useUpdateEcsuCircuit,
  useDeleteEcsuCircuit,
  type EcsuFormBody,
  type CircuitBindingBody,
} from '../hooks/useEcsu';

const { Title, Text } = Typography;

interface DeviceLite {
  device_id: string;
  edge_id?: string;
  device_kind?: string;
  display_name?: string | null;
}

interface CircuitRow {
  assgn_id: number;
  device_id: string;
  circuit_code: string;
  sign: -1 | 1;
  enabled: boolean;
  remark_desc?: string | null;
}

export default function EcsuDetail() {
  const { id } = useParams<{ id: string }>();
  const ecsuId = id ? parseInt(id, 10) : NaN;
  const navigate = useNavigate();

  // ─ ECSU 基本資料（reuse list；find by id）─
  const { data: rows } = useEcsuList();
  const ecsu = useMemo(
    () => rows?.find((r) => r.ecsu_id === ecsuId),
    [rows, ecsuId],
  );

  // ─ 三 stats ─
  const { data: circuitsData, isLoading: circuitsLoading, refetch: refetchCircuits } =
    useEcsuCircuits(Number.isNaN(ecsuId) ? null : ecsuId);
  const { data: realtimeData } = useEcsuRealtime(Number.isNaN(ecsuId) ? null : ecsuId);
  const { data: monthlyData } = useEcsuMonthly(Number.isNaN(ecsuId) ? null : ecsuId);

  // ─ Edge / Device 級聯 ─
  const { data: edgesData } = useEdges();
  const [bindEdgeId, setBindEdgeId] = useState<string | undefined>();
  const [edgeDevices, setEdgeDevices] = useState<DeviceLite[]>([]);
  const [edgeDevicesLoading, setEdgeDevicesLoading] = useState(false);

  useEffect(() => {
    if (!bindEdgeId) {
      setEdgeDevices([]);
      return;
    }
    setEdgeDevicesLoading(true);
    api
      .get<DeviceLite[]>('/admin/devices', { params: { edge_id: bindEdgeId } })
      .then((r) => {
        const items: DeviceLite[] = Array.isArray(r.data) ? r.data : (r.data as { items?: DeviceLite[] })?.items ?? [];
        // filter modbus_meter（其他 device_kind 如 thermal/relay 通常不掛 ECSU）
        setEdgeDevices(items.filter((d) => d.device_kind === 'modbus_meter' || d.device_kind === 'meter'));
      })
      .catch(() => setEdgeDevices([]))
      .finally(() => setEdgeDevicesLoading(false));
  }, [bindEdgeId]);

  // ─ Mutations ─
  const updateEcsu = useUpdateEcsu();
  const createCircuit = useCreateEcsuCircuit();
  const updateCircuit = useUpdateEcsuCircuit();
  const deleteCircuit = useDeleteEcsuCircuit();

  // ─ 編輯 ECSU 基本資料 Modal ─
  const [ecsuFormOpen, setEcsuFormOpen] = useState(false);
  const [ecsuForm] = Form.useForm<EcsuFormBody>();
  const openEcsuEdit = () => {
    if (!ecsu) return;
    ecsuForm.resetFields();
    ecsuForm.setFieldsValue({
      ecsu_code: ecsu.ecsu_code,
      ecsu_name: ecsu.ecsu_name,
      parent_id: ecsu.parent_id,
      display_seq: ecsu.display_seq,
      enabled: ecsu.enabled,
      remark_desc: ecsu.remark_desc ?? '',
    });
    setEcsuFormOpen(true);
  };
  const submitEcsuEdit = async () => {
    try {
      const body = await ecsuForm.validateFields();
      await updateEcsu.mutateAsync({ ecsu_id: ecsuId, ...body });
      message.success(`ECSU 已更新`);
      setEcsuFormOpen(false);
    } catch (err) {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      const detail = e?.response?.data?.detail ?? e?.message;
      if (detail) message.error(`更新失敗：${detail}`);
    }
  };

  // ─ enabled 即時 toggle（不需 Modal）─
  const toggleEnabled = async (next: boolean) => {
    if (!ecsu) return;
    try {
      await updateEcsu.mutateAsync({
        ecsu_id: ecsuId,
        ecsu_code: ecsu.ecsu_code,
        ecsu_name: ecsu.ecsu_name,
        parent_id: ecsu.parent_id,
        display_seq: ecsu.display_seq,
        enabled: next,
        remark_desc: ecsu.remark_desc,
      });
      message.success(`ECSU 已${next ? '啟用' : '停用'}`);
    } catch {
      message.error(`狀態切換失敗`);
    }
  };

  // ─ 新增綁定 dialog ─
  const [bindOpen, setBindOpen] = useState(false);
  const [bindForm] = Form.useForm<CircuitBindingBody>();
  const openBindCreate = () => {
    bindForm.resetFields();
    bindForm.setFieldsValue({
      device_id: '',
      circuit_code: '',
      sign: 1,
      enabled: true,
      remark_desc: '',
    });
    setBindEdgeId(undefined);
    setBindOpen(true);
  };
  const submitBindCreate = async () => {
    try {
      const body = await bindForm.validateFields();
      await createCircuit.mutateAsync({ ecsu_id: ecsuId, ...body });
      message.success(`綁定建立成功`);
      setBindOpen(false);
    } catch (err) {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      const detail = e?.response?.data?.detail ?? e?.message;
      if (detail) message.error(`綁定失敗：${detail}`);
    }
  };

  // ─ 編輯綁定 dialog（只改 sign / enabled / 備註）─
  const [editBindOpen, setEditBindOpen] = useState(false);
  const [editingCircuit, setEditingCircuit] = useState<CircuitRow | null>(null);
  const [editBindForm] = Form.useForm<{ sign: -1 | 1; enabled: boolean; remark_desc?: string | null }>();
  const openBindEdit = (c: CircuitRow) => {
    setEditingCircuit(c);
    editBindForm.resetFields();
    editBindForm.setFieldsValue({
      sign: c.sign,
      enabled: c.enabled,
      remark_desc: c.remark_desc ?? '',
    });
    setEditBindOpen(true);
  };
  const submitBindEdit = async () => {
    if (!editingCircuit) return;
    try {
      const body = await editBindForm.validateFields();
      await updateCircuit.mutateAsync({
        assgn_id: editingCircuit.assgn_id,
        ecsu_id: ecsuId,
        ...body,
      });
      message.success(`綁定已更新`);
      setEditBindOpen(false);
      setEditingCircuit(null);
    } catch (err) {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      const detail = e?.response?.data?.detail ?? e?.message;
      if (detail) message.error(`更新失敗：${detail}`);
    }
  };

  // ─ 移除綁定 ─
  const handleRemoveCircuit = async (c: CircuitRow) => {
    try {
      await deleteCircuit.mutateAsync({ assgn_id: c.assgn_id, ecsu_id: ecsuId });
      message.success(`綁定已移除`);
    } catch (err) {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      message.error(`移除失敗：${e?.response?.data?.detail ?? e?.message ?? '未知錯誤'}`);
    }
  };

  // 即時 kW 警示色
  const realtimeKw = realtimeData?.realtime_kw;
  const realtimeColor =
    realtimeKw == null
      ? undefined
      : realtimeKw > 0.001
        ? '#4caf50'
        : realtimeKw < -0.001
          ? '#ff9800'
          : '#888';

  // 綁定列表 columns
  const circuitColumns: ColumnsType<CircuitRow> = [
    { title: '設備 ID', dataIndex: 'device_id', key: 'device_id' },
    { title: '迴路代號', dataIndex: 'circuit_code', key: 'circuit_code', width: 130 },
    {
      title: 'Sign',
      dataIndex: 'sign',
      key: 'sign',
      width: 90,
      render: (v: -1 | 1) =>
        v === 1 ? (
          <Tag color="green">+1 加入</Tag>
        ) : (
          <Tag color="orange">-1 扣除</Tag>
        ),
    },
    {
      title: '狀態',
      dataIndex: 'enabled',
      key: 'enabled',
      width: 80,
      render: (v: boolean) =>
        v ? <Tag color="green">啟用</Tag> : <Tag color="default">停用</Tag>,
    },
    {
      title: '備註',
      dataIndex: 'remark_desc',
      key: 'remark_desc',
      render: (v: string | null) => v || <Text type="secondary">—</Text>,
    },
    {
      title: '操作',
      key: 'action',
      width: 130,
      render: (_: unknown, row: CircuitRow) => (
        <Space size={4}>
          <Button size="small" icon={<EditOutlined />} onClick={() => openBindEdit(row)}>
            編輯
          </Button>
          <Popconfirm
            title={`移除此綁定？`}
            description={`device_id=${row.device_id} circuit=${row.circuit_code}`}
            okText="確認移除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={() => handleRemoveCircuit(row)}
          >
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  if (Number.isNaN(ecsuId)) {
    return <Alert type="error" message="無效的 ECSU ID" />;
  }

  if (!ecsu && rows) {
    // list 已載入但找不到 → 404
    return (
      <div>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/ecsu')}>
          返回列表
        </Button>
        <Alert
          type="error"
          message={`ECSU ID ${ecsuId} 不存在`}
          style={{ marginTop: 16 }}
        />
      </div>
    );
  }

  return (
    <div>
      <Breadcrumb
        style={{ marginBottom: 12 }}
        items={[
          {
            title: (
              <a onClick={() => navigate('/ecsu')}>
                <ArrowLeftOutlined /> 用電計費單位 (ECSU)
              </a>
            ),
          },
          { title: ecsu?.ecsu_code ?? `#${ecsuId}` },
        ]}
      />
      <Title level={3} style={{ marginTop: 0 }}>
        {ecsu ? `${ecsu.ecsu_code} - ${ecsu.ecsu_name}` : <Spin />}
      </Title>

      {/* ─ 上半部 ─ */}
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={16}>
          <Card title="基本資料" extra={
            <Button icon={<EditOutlined />} onClick={openEcsuEdit} disabled={!ecsu}>編輯</Button>
          }>
            <Descriptions column={2} size="small">
              <Descriptions.Item label="ID">{ecsu?.ecsu_id ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="代碼">{ecsu?.ecsu_code ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="名稱">{ecsu?.ecsu_name ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="上層 ID">
                {ecsu?.parent_id ?? <Text type="secondary">(頂級)</Text>}
              </Descriptions.Item>
              <Descriptions.Item label="顯示順序">{ecsu?.display_seq ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="狀態">
                <Switch
                  checked={ecsu?.enabled ?? false}
                  onChange={toggleEnabled}
                  checkedChildren="啟用"
                  unCheckedChildren="停用"
                  disabled={!ecsu}
                />
              </Descriptions.Item>
              <Descriptions.Item label="備註" span={2}>
                {ecsu?.remark_desc || <Text type="secondary">—</Text>}
              </Descriptions.Item>
            </Descriptions>
          </Card>
        </Col>
        <Col span={8}>
          <Card title="即時統計">
            <Row gutter={8}>
              <Col span={8}>
                <Statistic
                  title="即時 (kW)"
                  value={realtimeKw ?? 0}
                  precision={2}
                  valueStyle={{ color: realtimeColor, fontFamily: 'monospace' }}
                />
              </Col>
              <Col span={8}>
                <Statistic
                  title="本月 (kWh)"
                  value={monthlyData?.monthly_kwh ?? 0}
                  precision={1}
                  valueStyle={{ fontFamily: 'monospace' }}
                />
              </Col>
              <Col span={8}>
                <Statistic
                  title="綁定數"
                  value={circuitsData?.count ?? 0}
                />
              </Col>
            </Row>
            <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 8 }}>
              即時 30s 自動更新；月為 month-to-date
            </Text>
          </Card>
        </Col>
      </Row>

      {/* ─ 下半部：多對多綁定 ─ */}
      <Card
        title="用電統計來源（多對多綁定）"
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={() => refetchCircuits()}>
              重新整理
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={openBindCreate}>
              新增綁定
            </Button>
          </Space>
        }
      >
        <Table<CircuitRow>
          rowKey="assgn_id"
          columns={circuitColumns}
          dataSource={(circuitsData?.circuits ?? []) as CircuitRow[]}
          loading={circuitsLoading}
          size="small"
          pagination={false}
          locale={{
            emptyText: '(尚未綁定迴路) 點 [+ 新增綁定] 開始',
          }}
        />
      </Card>

      {/* ─ 編輯 ECSU 基本資料 Modal ─ */}
      <Modal
        title={`編輯 ECSU - ${ecsu?.ecsu_code ?? ''}`}
        open={ecsuFormOpen}
        onCancel={() => setEcsuFormOpen(false)}
        onOk={submitEcsuEdit}
        confirmLoading={updateEcsu.isPending}
        destroyOnHidden
        width={520}
      >
        <Form form={ecsuForm} layout="vertical" preserve={false}>
          <Form.Item name="ecsu_code" label="代碼" rules={[{ required: true }]}>
            <Input disabled />
          </Form.Item>
          <Form.Item name="ecsu_name" label="名稱" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="parent_id" label="上層 ID（選填）">
            <InputNumber style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="display_seq" label="顯示順序">
            <InputNumber style={{ width: '100%' }} min={1} />
          </Form.Item>
          <Form.Item name="enabled" label="啟用" valuePropName="checked">
            <Switch checkedChildren="啟用" unCheckedChildren="停用" />
          </Form.Item>
          <Form.Item name="remark_desc" label="備註">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>

      {/* ─ 新增綁定 Modal ─ */}
      <Modal
        title={`新增綁定到 ${ecsu?.ecsu_code ?? '...'}`}
        open={bindOpen}
        onCancel={() => setBindOpen(false)}
        onOk={submitBindCreate}
        confirmLoading={createCircuit.isPending}
        destroyOnHidden
        width={560}
      >
        <Form form={bindForm} layout="vertical" preserve={false}>
          <Form.Item label="Edge" required>
            <Select
              value={bindEdgeId}
              onChange={(v) => {
                setBindEdgeId(v);
                bindForm.setFieldValue('device_id', '');
              }}
              placeholder="選擇 Edge"
              options={(edgesData ?? []).map((e) => ({
                value: e.edge_id,
                label: e.edge_id + (e.edge_name && e.edge_name !== e.edge_id ? ` · ${e.edge_name}` : ''),
              }))}
              showSearch
            />
          </Form.Item>
          <Form.Item
            name="device_id"
            label="設備"
            rules={[{ required: true, message: '請選擇設備' }]}
          >
            <Select
              disabled={!bindEdgeId}
              placeholder={bindEdgeId ? (edgeDevicesLoading ? '載入中…' : '選擇設備') : '請先選 Edge'}
              loading={edgeDevicesLoading}
              options={edgeDevices.map((d) => ({
                value: d.device_id,
                label: `${d.device_id}${d.display_name ? ' · ' + d.display_name : ''}`,
              }))}
              showSearch
            />
          </Form.Item>
          <Form.Item
            name="circuit_code"
            label="迴路代號"
            rules={[{ required: true, message: '迴路代號必填' }]}
            extra="例：main / ba1 / bb12 / l1（依設備種類；自由輸入）"
          >
            <Input placeholder="例如：main 或 ba1" />
          </Form.Item>
          <Form.Item
            name="sign"
            label="Sign（聚合方向）"
            rules={[{ required: true }]}
          >
            <Radio.Group>
              <Radio value={1}>+1 加入聚合（消耗用電；預設）</Radio>
              <Radio value={-1}>-1 從聚合扣除（反向潮流 / 太陽能反送）</Radio>
            </Radio.Group>
          </Form.Item>
          <Form.Item name="enabled" label="啟用" valuePropName="checked">
            <Switch checkedChildren="啟用" unCheckedChildren="停用" />
          </Form.Item>
          <Form.Item name="remark_desc" label="備註">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>

      {/* ─ 編輯綁定 Modal ─ */}
      <Modal
        title={editingCircuit ? `編輯綁定 #${editingCircuit.assgn_id}` : '編輯綁定'}
        open={editBindOpen}
        onCancel={() => {
          setEditBindOpen(false);
          setEditingCircuit(null);
        }}
        onOk={submitBindEdit}
        confirmLoading={updateCircuit.isPending}
        destroyOnHidden
        width={520}
      >
        {editingCircuit && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12, fontSize: 12 }}
            message={`device_id=${editingCircuit.device_id} circuit=${editingCircuit.circuit_code}（不可改；要改請先移除重建）`}
          />
        )}
        <Form form={editBindForm} layout="vertical" preserve={false}>
          <Form.Item name="sign" label="Sign（聚合方向）" rules={[{ required: true }]}>
            <Radio.Group>
              <Radio value={1}>+1 加入聚合</Radio>
              <Radio value={-1}>-1 扣除</Radio>
            </Radio.Group>
          </Form.Item>
          <Form.Item name="enabled" label="啟用" valuePropName="checked">
            <Switch checkedChildren="啟用" unCheckedChildren="停用" />
          </Form.Item>
          <Form.Item name="remark_desc" label="備註">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
