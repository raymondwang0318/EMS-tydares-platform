import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Empty, Typography } from 'antd';
import AdminLayout from './layouts/AdminLayout';
import Login from './pages/Login';            // M-PM-309: 登入頁（取代 placeholder）
import AdminUsers from './pages/AdminUsers';  // M-PM-309: 用戶管理 MVP 框架
import Edges from './pages/Edges';
import Dashboard from './pages/Dashboard';
import ModbusDevices from './pages/ModbusDevices';
import ModbusModels from './pages/ModbusModels';
import Ecsu from './pages/Ecsu';
import EcsuDetail from './pages/EcsuDetail';   // M-PM-220: ECSU 詳情頁
import BillingStandard from './pages/BillingStandard';
import Reports from './pages/Reports';
import Trends from './pages/Trends';   // M-PM-202: 趨勢圖獨立分項
import IrDevices from './pages/IrDevices';
import ThermalView from './pages/ThermalView';
import RemoteIO from './pages/RemoteIO';   // M-PM-240 Phase A: 遠端 I/O 監控頁（mock 階段）
import IOSettings from './pages/IOSettings';  // M-PM-289 §B: 遠端 I/O 設定頁
import AnomalyHistory from './pages/AnomalyHistory';  // M-PM-306: 異常履歷頁
import SystemSettings from './pages/SystemSettings';  // M-PM-313 P4: 系統設定（mail 收件人）

const { Title } = Typography;

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
        <Route path="/login" element={<Login />} />
        <Route element={<AdminLayout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/edges" element={<Edges />} />
          <Route path="/devices" element={<ModbusDevices />} />
          <Route path="/device-models" element={<ModbusModels />} />
          <Route path="/ecsu" element={<Ecsu />} />
          <Route path="/ecsu/:id" element={<EcsuDetail />} />
          <Route path="/billing" element={<BillingStandard />} />
          <Route path="/ir-devices" element={<IrDevices />} />
          <Route path="/thermal/all" element={<ThermalView />} />
          <Route path="/io" element={<RemoteIO />} />
          <Route path="/io-settings" element={<IOSettings />} />  {/* M-PM-289 §B */}
          <Route path="/events" element={<AnomalyHistory />} />  {/* M-PM-306 */}
          <Route path="/reports" element={<Reports />} />
          <Route path="/trends" element={<Trends />} />
          <Route path="/config" element={<SystemSettings />} />
          <Route path="/users" element={<AdminUsers />} />  {/* M-PM-309 */}
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
