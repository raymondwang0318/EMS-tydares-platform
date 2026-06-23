import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { message } from 'antd';
import { clearToken, getToken } from '../lib/auth';

function resolveBaseURL(): string {
  const envBase = import.meta.env.VITE_API_BASE_URL;
  if (!envBase) return '/v1';
  const trimmed = envBase.replace(/\/+$/, '');
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

const api = axios.create({
  baseURL: resolveBaseURL(),
  timeout: 15000,
  withCredentials: true,  // M-PM-309: 送 session cookie（ems_session）
  headers: {
    'Content-Type': 'application/json',
  },
});

api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const token = getToken();
  if (token) {
    config.headers.set('Authorization', `Bearer ${token}`);
  }
  return config;
});

let authErrorShownAt = 0;
const AUTH_ERROR_COOLDOWN_MS = 3000;

api.interceptors.response.use(
  (response) => response,
  (error: AxiosError<{ detail?: string }>) => {
    const status = error.response?.status;
    // M-PM-309: auth 端點（/me 還原 session、login 錯密碼）的 401 由呼叫端自行處理，不走全域提示/跳轉
    if (error.config?.url?.includes('/admin/auth/')) {
      return Promise.reject(error);
    }
    // 議題C(M-PM-341)：熱力圖 Open View — 訪客在 /thermal/all 看熱力圖時，edges/ir-devices 的
    // 401/403 不踢 login（讓訪客留頁；數據由 P12A 開放 read-only 後自然顯示），避免 iframe 被導去登入頁
    const onThermalPublic = window.location.pathname.includes('/thermal/all');
    if (onThermalPublic && (error.config?.url?.includes('/edges') || error.config?.url?.includes('/ir-devices'))) {
      return Promise.reject(error);
    }
    if (status === 401 || status === 403) {
      const now = Date.now();
      if (now - authErrorShownAt > AUTH_ERROR_COOLDOWN_MS) {
        authErrorShownAt = now;
        const text = status === 401 ? '登入逾時或未登入，請重新登入' : '權限不足，無法執行此操作';
        message.error(text);
        if (status === 401) {
          clearToken();
          if (window.location.pathname !== '/admin-ui/login' && window.location.pathname !== '/login') {
            window.location.href = '/admin-ui/login';
          }
        }
      }
    } else if (status && status >= 500) {
      message.error(`後端錯誤 (${status})：${error.response?.data?.detail ?? error.message}`);
    }
    return Promise.reject(error);
  },
);

export default api;
