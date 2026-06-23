/**
 * 用戶管理（用戶管理卷，2026-06-11 老王派工「完善後台的使用者管理」）.
 *
 * - 列表：帳號 / 角色 / 狀態 / 最後登入 / 線上 session / 操作
 * - 新增用戶（admin / viewer）、重設密碼、啟用停用、角色切換、刪除
 * - 護欄與 backend 對齊：自己列停用/降級/刪除禁用；錯誤 detail 直接顯示
 * - viewer 登入：唯讀渲染（無操作欄），仍可改自己密碼
 */
import { useState } from 'react';
import {
  Alert, App as AntdApp, Button, Card, Form, Input, Modal, Popconfirm,
  Select, Space, Switch, Table, Tag, Tooltip, Typography,
} from 'antd';
import { KeyOutlined, PlusOutlined, UserOutlined } from '@ant-design/icons';
import type { AxiosError } from 'axios';
import { useAuth } from '../lib/authContext';
import {
  type AdminUserRow, useAdminUsers, useChangeMyPassword,
  useCreateAdminUser, useDeleteAdminUser, useUpdateAdminUser,
} from '../hooks/useAdminUsers';

const { Title, Text } = Typography;

const ROLE_META: Record<string, { color: string; label: string; desc: string }> = {
  admin: { color: 'green', label: 'admin（全功能）', desc: '可操作所有後台功能與用戶管理' },
  viewer: { color: 'blue', label: 'viewer（唯讀）', desc: '只能瀏覽，所有寫入操作會被拒絕' },
};

function fmt(ts: string | null): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('zh-TW', { hour12: false });
}

function errDetail(e: unknown, fallback: string): string {
  return (e as AxiosError<{ detail?: string }>).response?.data?.detail ?? fallback;
}

export default function AdminUsers() {
  const { user: me } = useAuth();
  const { message } = AntdApp.useApp();
  const { data: users = [], isLoading } = useAdminUsers();
  const createUser = useCreateAdminUser();
  const updateUser = useUpdateAdminUser();
  const deleteUser = useDeleteAdminUser();
  const changeMyPassword = useChangeMyPassword();

  const isViewer = me?.role !== 'admin';

  const [createOpen, setCreateOpen] = useState(false);
  const [resetTarget, setResetTarget] = useState<AdminUserRow | null>(null);
  const [changePwOpen, setChangePwOpen] = useState(false);
  const [createForm] = Form.useForm();
  const [resetForm] = Form.useForm();
  const [changePwForm] = Form.useForm();

  const onCreate = async (v: { username: string; password: string; role: string; can_control_io?: boolean }) => {
    try {
      await createUser.mutateAsync(v);
      message.success(`已新增用戶 ${v.username}`);
      setCreateOpen(false);
      createForm.resetFields();
    } catch (e) {
      message.error(errDetail(e, '新增失敗'));
    }
  };

  const onResetPassword = async (v: { password: string }) => {
    if (!resetTarget) return;
    try {
      await updateUser.mutateAsync({ id: resetTarget.user_id, patch: { password: v.password } });
      message.success(`已重設 ${resetTarget.username} 的密碼（其所有登入已登出）`);
      setResetTarget(null);
      resetForm.resetFields();
    } catch (e) {
      message.error(errDetail(e, '重設失敗'));
    }
  };

  const onChangeMyPassword = async (v: { current_password: string; new_password: string }) => {
    try {
      await changeMyPassword.mutateAsync(v);
      message.success('密碼已更新（本裝置免重登，其他裝置已登出）');
      setChangePwOpen(false);
      changePwForm.resetFields();
    } catch (e) {
      message.error(errDetail(e, '改密碼失敗'));
    }
  };

  const onToggleActive = async (u: AdminUserRow, next: boolean) => {
    try {
      await updateUser.mutateAsync({ id: u.user_id, patch: { is_active: next } });
      message.success(`${u.username} 已${next ? '啟用' : '停用'}`);
    } catch (e) {
      message.error(errDetail(e, '操作失敗'));
    }
  };

  const onToggleIO = async (u: AdminUserRow, next: boolean) => {
    try {
      await updateUser.mutateAsync({ id: u.user_id, patch: { can_control_io: next } });
      message.success(`${u.username} 已${next ? '開啟' : '關閉'} I/O 控制權`);
    } catch (e) {
      message.error(errDetail(e, '操作失敗'));
    }
  };

  const onChangeRole = async (u: AdminUserRow, role: string) => {
    try {
      await updateUser.mutateAsync({ id: u.user_id, patch: { role } });
      message.success(`${u.username} 角色已改為 ${role}`);
    } catch (e) {
      message.error(errDetail(e, '操作失敗'));
    }
  };

  const onDelete = async (u: AdminUserRow) => {
    try {
      await deleteUser.mutateAsync(u.user_id);
      message.success(`已刪除用戶 ${u.username}`);
    } catch (e) {
      message.error(errDetail(e, '刪除失敗'));
    }
  };

  const columns = [
    {
      title: '帳號',
      dataIndex: 'username',
      render: (v: string) => (
        <Space>
          <UserOutlined />
          <Text strong>{v}</Text>
          {v === me?.username && <Tag color="gold">自己</Tag>}
        </Space>
      ),
    },
    {
      title: '角色',
      dataIndex: 'role',
      width: 200,
      render: (v: string, u: AdminUserRow) => {
        const meta = ROLE_META[v] ?? { color: 'default', label: v, desc: '' };
        if (isViewer || u.username === me?.username) {
          return <Tooltip title={meta.desc}><Tag color={meta.color}>{meta.label}</Tag></Tooltip>;
        }
        return (
          <Select
            size="small"
            value={v}
            style={{ width: 170 }}
            onChange={(role) => onChangeRole(u, role)}
            options={Object.entries(ROLE_META).map(([k, m]) => ({ value: k, label: m.label }))}
          />
        );
      },
    },
    {
      title: '狀態',
      dataIndex: 'is_active',
      width: 110,
      render: (v: boolean, u: AdminUserRow) => (
        isViewer ? (
          <Tag color={v ? 'green' : 'red'}>{v ? '啟用' : '停用'}</Tag>
        ) : (
          <Tooltip title={u.username === me?.username ? '不可停用自己（防鎖死）' : ''}>
            <Switch
              size="small"
              checked={v}
              disabled={u.username === me?.username}
              checkedChildren="啟用"
              unCheckedChildren="停用"
              onChange={(next) => onToggleActive(u, next)}
            />
          </Tooltip>
        )
      ),
    },
    {
      title: (
        <Tooltip title="I/O 控制權：可操作遠端風扇 relay/DO（實體繼電器）。獨立於角色綁帳號 — viewer＋此權＝現場操作員（唯讀但能控風扇）；admin 也可被關閉。後端為真正安全邊界。">
          <span>I/O 控制權</span>
        </Tooltip>
      ),
      dataIndex: 'can_control_io',
      width: 120,
      render: (v: boolean, u: AdminUserRow) => (
        isViewer ? (
          <Tag color={v ? 'volcano' : 'default'}>{v ? '可控 I/O' : '—'}</Tag>
        ) : (
          <Switch
            size="small"
            checked={v}
            checkedChildren="可控"
            unCheckedChildren="禁用"
            onChange={(next) => onToggleIO(u, next)}
          />
        )
      ),
    },
    { title: '最後登入', dataIndex: 'last_login_at', width: 170, render: fmt },
    {
      title: '線上',
      dataIndex: 'active_sessions',
      width: 70,
      render: (n: number) => (n > 0 ? <Tag color="green">{n}</Tag> : <Text type="secondary">0</Text>),
    },
    { title: '建立時間', dataIndex: 'created_at', width: 170, render: fmt },
    ...(isViewer ? [] : [{
      title: '操作',
      key: 'actions',
      width: 220,
      render: (_: unknown, u: AdminUserRow) => (
        <Space>
          {u.username === me?.username ? (
            <Button size="small" icon={<KeyOutlined />} onClick={() => setChangePwOpen(true)}>
              改密碼
            </Button>
          ) : (
            <>
              <Button size="small" icon={<KeyOutlined />} onClick={() => setResetTarget(u)}>
                重設密碼
              </Button>
              <Popconfirm
                title={`確定刪除用戶 ${u.username}？`}
                description="刪除後該帳號立即失效，操作會記錄到事件履歷。"
                okText="刪除"
                okButtonProps={{ danger: true }}
                cancelText="取消"
                onConfirm={() => onDelete(u)}
              >
                <Button size="small" danger>刪除</Button>
              </Popconfirm>
            </>
          )}
        </Space>
      ),
    }]),
  ];

  return (
    <div>
      <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 16 }}>
        <Title level={3} style={{ margin: 0 }}>用戶管理</Title>
        {!isViewer && (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            新增用戶
          </Button>
        )}
      </Space>

      {isViewer && (
        <Alert
          style={{ marginBottom: 16 }}
          type="info"
          showIcon
          message="你是唯讀帳號（viewer），僅能瀏覽；可點自己列的「改密碼」更新密碼。"
        />
      )}

      <Card>
        <Table<AdminUserRow>
          rowKey="user_id"
          size="middle"
          loading={isLoading}
          dataSource={users}
          columns={columns}
          pagination={false}
        />
      </Card>

      {/* 新增用戶 */}
      <Modal
        title="新增後台用戶"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => createForm.submit()}
        confirmLoading={createUser.isPending}
        okText="建立"
        cancelText="取消"
      >
        <Form form={createForm} layout="vertical" onFinish={onCreate} initialValues={{ role: 'viewer', can_control_io: false }}>
          <Form.Item name="username" label="帳號" rules={[{ required: true, message: '請輸入帳號' }]}>
            <Input maxLength={64} autoComplete="off" />
          </Form.Item>
          <Form.Item
            name="password"
            label="密碼（至少 8 碼）"
            rules={[{ required: true, min: 8, message: '密碼至少 8 碼' }]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item
            name="confirm"
            label="確認密碼"
            dependencies={['password']}
            rules={[
              { required: true, message: '請再輸入一次密碼' },
              ({ getFieldValue }) => ({
                validator: (_, v) =>
                  v === getFieldValue('password') ? Promise.resolve() : Promise.reject(new Error('兩次密碼不一致')),
              }),
            ]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item name="role" label="角色" rules={[{ required: true }]}>
            <Select
              options={Object.entries(ROLE_META).map(([k, m]) => ({
                value: k, label: `${m.label} — ${m.desc}`,
              }))}
            />
          </Form.Item>
          <Form.Item
            name="can_control_io"
            label="I/O 控制權"
            valuePropName="checked"
            tooltip="開啟＝可操作遠端風扇 relay/DO（現場操作員）。可獨立授予 viewer；後端為真正安全邊界。"
          >
            <Switch checkedChildren="可控 I/O" unCheckedChildren="無" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 重設他人密碼 */}
      <Modal
        title={`重設 ${resetTarget?.username ?? ''} 的密碼`}
        open={resetTarget !== null}
        onCancel={() => setResetTarget(null)}
        onOk={() => resetForm.submit()}
        confirmLoading={updateUser.isPending}
        okText="重設"
        cancelText="取消"
      >
        <Alert
          style={{ marginBottom: 16 }}
          type="warning"
          showIcon
          message="重設後該用戶所有登入立即登出，需用新密碼重登。"
        />
        <Form form={resetForm} layout="vertical" onFinish={onResetPassword}>
          <Form.Item
            name="password"
            label="新密碼（至少 8 碼）"
            rules={[{ required: true, min: 8, message: '密碼至少 8 碼' }]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item
            name="confirm"
            label="確認新密碼"
            dependencies={['password']}
            rules={[
              { required: true, message: '請再輸入一次密碼' },
              ({ getFieldValue }) => ({
                validator: (_, v) =>
                  v === getFieldValue('password') ? Promise.resolve() : Promise.reject(new Error('兩次密碼不一致')),
              }),
            ]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 改自己密碼 */}
      <Modal
        title="修改自己的密碼"
        open={changePwOpen}
        onCancel={() => setChangePwOpen(false)}
        onOk={() => changePwForm.submit()}
        confirmLoading={changeMyPassword.isPending}
        okText="更新密碼"
        cancelText="取消"
      >
        <Form form={changePwForm} layout="vertical" onFinish={onChangeMyPassword}>
          <Form.Item
            name="current_password"
            label="目前密碼"
            rules={[{ required: true, message: '請輸入目前密碼' }]}
          >
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Form.Item
            name="new_password"
            label="新密碼（至少 8 碼）"
            rules={[{ required: true, min: 8, message: '密碼至少 8 碼' }]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item
            name="confirm"
            label="確認新密碼"
            dependencies={['new_password']}
            rules={[
              { required: true, message: '請再輸入一次密碼' },
              ({ getFieldValue }) => ({
                validator: (_, v) =>
                  v === getFieldValue('new_password') ? Promise.resolve() : Promise.reject(new Error('兩次密碼不一致')),
              }),
            ]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
