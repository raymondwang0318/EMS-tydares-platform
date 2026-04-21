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
    if (status === 401 || status === 403) {
      const now = Date.now();
      if (now - authErrorShownAt > AUTH_ERROR_COOLDOWN_MS) {
        authErrorShownAt = now;
        const text = status === 401 ? 'Token 失效或未設定，請更新環境變數 VITE_API_TOKEN 後重新整理' : '權限不足，無法執行此操作';
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
