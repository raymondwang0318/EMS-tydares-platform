/**
 * 後台用戶管理 hooks（用戶管理卷，2026-06-11）— mirror useMailRecipients pattern.
 * 對接 v1_admin_users.py：GET/POST /v1/admin/users、PATCH/DELETE /{id}
 * + v1_auth.py：POST /v1/admin/auth/change-password（自助改密碼）
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '../services/api';

export interface AdminUserRow {
  user_id: number;
  username: string;
  role: 'admin' | 'viewer' | string;
  can_control_io: boolean;
  is_active: boolean;
  created_at: string | null;
  updated_at: string | null;
  last_login_at: string | null;
  active_sessions: number;
}

const KEY = ['admin-users'] as const;

export function useAdminUsers() {
  return useQuery({
    queryKey: KEY,
    queryFn: async () => {
      const r = await api.get<AdminUserRow[]>('/admin/users');
      return Array.isArray(r.data) ? r.data : [];
    },
    staleTime: 15_000,
  });
}

export function useCreateAdminUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { username: string; password: string; role: string; can_control_io?: boolean }) => {
      const r = await api.post<AdminUserRow>('/admin/users', body);
      return r.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useUpdateAdminUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: {
      id: number;
      patch: { role?: string; is_active?: boolean; password?: string; can_control_io?: boolean };
    }) => {
      const r = await api.patch(`/admin/users/${id}`, patch);
      return r.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useDeleteAdminUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const r = await api.delete(`/admin/users/${id}`);
      return r.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useChangeMyPassword() {
  return useMutation({
    mutationFn: async (body: { current_password: string; new_password: string }) => {
      const r = await api.post('/admin/auth/change-password', body);
      return r.data;
    },
  });
}
