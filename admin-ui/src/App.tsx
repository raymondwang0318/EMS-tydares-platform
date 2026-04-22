import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Empty, Typography, Alert } from 'antd';
import AdminLayout from './layouts/AdminLayout';
import Edges from './pages/Edges';
import Dashboard from './pages/Dashboard';
import ModbusDevices from './pages/ModbusDevices';
import ModbusModels from './pages/ModbusModels';
import Ecsu from './pages/Ecsu';
import BillingStandard from './pages/BillingStandard';
import Reports from './pages/Reports';

const { Title, Paragraph } = Typography;

function ConfigPlaceholder() {
  return (
    <div>
      <Title level={3} style={{ marginTop: 0 }}>系統設定</Title>
      <Alert
        type="info"
        showIcon
        message="Central V2-final 目前未提供 /v1/admin/configs 端點"
        description="舊版 /admin/configs CRUD 已於 Oracle 下線階段棄用；V2-final 的系統設定改走 docker-compose env_file (api/.env) + ADR-026 定義。若需要管理介面，由下一 phase 另規劃 endpoint。"
      />
    </div>
  );
}

function LoginPlaceholder() {
  return (
    <div style={{ padding: 48, maxWidth: 480, margin: '64px auto' }}>
      <Title level={3}>Token 失效</Title>
      <Paragraph>
        目前 Admin UI 尚未實作登入頁（屬另立 ADR 範疇）。
        請更新環境變數 <code>VITE_API_TOKEN</code> 後重新整理。
      </Paragraph>
    </div>
  );
}

function NotFound() {
  return (
    <div>
      <Title level={3} style={{ marginTop: 0 }}>404</Title>
      <Empty description="此頁不存在，請從左側選單導航" />
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter basename="/admin-ui">
      <Routes>
        <Route path="/login" element={<LoginPlaceholder />} />
        <Route element={<AdminLayout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/edges" element={<Edges />} />
          <Route path="/devices" element={<ModbusDevices />} />
          <Route path="/device-models" element={<ModbusModels />} />
          <Route path="/ecsu" element={<Ecsu />} />
          <Route path="/billing" element={<BillingStandard />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/config" element={<ConfigPlaceholder />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
