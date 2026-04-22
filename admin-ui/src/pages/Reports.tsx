import { useEffect, useState } from 'react';
import { Table, Tabs, DatePicker, Space, Button, message, Tag, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { Dayjs } from 'dayjs';
import api from '../services/api';

const { Title } = Typography;
const { RangePicker } = DatePicker;

interface EventRow {
  event_id?: number | string;
  ts?: string;
  event_kind?: string;
  severity?: string;
  edge_id?: string;
  device_id?: string;
  message?: string;
}

const eventColumns: ColumnsType<EventRow> = [
  { title: '時間', dataIndex: 'ts', key: 'ts', width: 200, render: (v) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm:ss') : '-') },
  {
    title: '嚴重度',
    dataIndex: 'severity',
    key: 'severity',
    width: 100,
    render: (v: string) => {
      const color =
        v === 'critical' ? 'red' : v === 'warn' ? 'orange' : v === 'info' ? 'blue' : 'default';
      return v ? <Tag color={color}>{v}</Tag> : null;
    },
  },
  { title: '類別', dataIndex: 'event_kind', key: 'event_kind', width: 140 },
  { title: 'Edge', dataIndex: 'edge_id', key: 'edge_id', width: 160 },
  { title: '設備', dataIndex: 'device_id', key: 'device_id', width: 180 },
  { title: '訊息', dataIndex: 'message', key: 'message', ellipsis: true },
];

/**
 * V2-final 報表頁
 * 對接：/v1/reports/events / /v1/reports/energy（預留 Tab）/ /v1/reports/thermal（預留 Tab）
 * 初版聚焦「事件 Events」最常用；能量與熱像接入留給後續 Phase。
 */
export default function Reports() {
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs().subtract(24, 'hour'), dayjs()]);

  const fetchEvents = async () => {
    setLoading(true);
    try {
      const res = await api.get('/reports/events', {
        params: {
          from_ts: range[0].toISOString(),
          to_ts: range[1].toISOString(),
          limit: 500,
        },
      });
      const items = Array.isArray(res.data) ? res.data : res.data?.items ?? [];
      setEvents(items);
    } catch (e: any) {
      message.error(`載入失敗：${e.message}`);
      setEvents([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchEvents();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      <Title level={3} style={{ marginTop: 0 }}>報表</Title>
      <Tabs
        defaultActiveKey="events"
        items={[
          {
            key: 'events',
            label: '事件 Events',
            children: (
              <>
                <Space style={{ marginBottom: 16 }}>
                  <RangePicker
                    showTime
                    value={range}
                    onChange={(v) => v && v[0] && v[1] && setRange([v[0], v[1]])}
                  />
                  <Button type="primary" icon={<ReloadOutlined />} onClick={fetchEvents}>
                    查詢
                  </Button>
                </Space>
                <Table<EventRow>
                  columns={eventColumns}
                  dataSource={events}
                  rowKey={(r) => String(r.event_id ?? `${r.ts}-${r.edge_id}-${r.device_id}`)}
                  loading={loading}
                  size="small"
                  pagination={{ pageSize: 20 }}
                />
              </>
            ),
          },
          {
            key: 'energy',
            label: '能量 Energy',
            children: <div style={{ padding: 24, color: '#666' }}>對接 /v1/reports/energy 預留；下一 Phase 實作</div>,
          },
          {
            key: 'thermal',
            label: '熱像 Thermal',
            children: <div style={{ padding: 24, color: '#666' }}>對接 /v1/reports/thermal 預留；下一 Phase 實作</div>,
          },
        ]}
      />
    </div>
  );
}
