/**
 * M-PM-309 admin-ui 登入 context（mirror ThemeProvider pattern，lib/theme.tsx）.
 *
 * - mount 時 GET /v1/admin/auth/me 還原 session（cookie HttpOnly，前端不碰 token）
 * - login()/logout() 走 v1_auth 端點；Set-Cookie 由瀏覽器自動帶（api.ts withCredentials）
 * - 範圍僅 admin-ui 後台維護 UI（老王 2026-06-05 明示；Boss 前台另立）
 */
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import api from '../services/api';

export interface AdminUser {
  username: string;
  role: string;
  can_control_io?: boolean;  // M-P12-120 件1b：I/O 控制權（ems-api /me 回；遠端 I/O 鈕 gate）
}

export type AuthVia = 'session' | 'bearer';

interface AuthContextValue {
  user: AdminUser | null;
  via: AuthVia | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within <AuthProvider>');
  }
  return ctx;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AdminUser | null>(null);
  const [via, setVia] = useState<AuthVia | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/admin/auth/me')
      .then((res) => {
        // M-P12-108：via=bearer 只在「被嵌入」時接受（Pananora 前台嵌 admin-ui 頁面）；
        // 直接訪客（top-level）仍走帳密登入閘
        const embedded = window.self !== window.top;
        if (res.data.via === 'bearer' && !embedded) {
          setUser(null);
        } else {
          setUser(res.data.user);
          setVia(res.data.via);
        }
      })
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const res = await api.post('/admin/auth/login', { username, password });
    setUser(res.data.user);
    setVia('session');
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post('/admin/auth/logout');
    } catch {
      // session 已失效也視為登出成功
    }
    setUser(null);
    setVia(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, via, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
