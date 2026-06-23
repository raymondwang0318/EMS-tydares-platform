/**
 * M-PM-309 admin-ui 登入頁（取代 LoginPlaceholder）.
 * 帳密 → AuthContext.login（POST /v1/admin/auth/login，session cookie 24h）→ 回首頁。
 */
import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Alert, Button, Card, Form, Input, Typography } from 'antd';
import { LockOutlined, UserOutlined } from '@ant-design/icons';
import type { AxiosError } from 'axios';
import { useAuth } from '../lib/authContext';

const { Title, Text } = Typography;

export default function Login() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // 已登入直接回首頁（避免重複登入）
  if (user) return <Navigate to="/" replace />;

  const onFinish = async (values: { username: string; password: string }) => {
    setSubmitting(true);
    setError(null);
    try {
      await login(values.username, values.password);
      navigate('/', { replace: true });
    } catch (e) {
      const detail = (e as AxiosError<{ detail?: string }>).response?.data?.detail;
      setError(detail ?? '登入失敗，請稍後再試（後端無回應）');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#e8f5e9' }}>
      <Card style={{ width: 380, boxShadow: '0 2px 12px rgba(0,0,0,0.08)' }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <Title level={4} style={{ marginBottom: 4 }}>Tydares EMS — 工程維護</Title>
          <Text type="secondary">請登入後台管理帳號</Text>
        </div>
        {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />}
        <Form onFinish={onFinish} size="large" requiredMark={false}>
          <Form.Item name="username" rules={[{ required: true, message: '請輸入帳號' }]}>
            <Input prefix={<UserOutlined />} placeholder="帳號" autoFocus autoComplete="username" />
          </Form.Item>
          <Form.Item name="password" rules={[{ required: true, message: '請輸入密碼' }]}>
            <Input.Password prefix={<LockOutlined />} placeholder="密碼" autoComplete="current-password" />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0 }}>
            <Button type="primary" htmlType="submit" block loading={submitting}>
              登入
            </Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  );
}
