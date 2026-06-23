/**
 * Mail recipient hooks（M-PM-313 階段2 P4）— admin 管全部收件人。
 * 對接 v1_admin_events.py：GET/POST/PATCH/DELETE /v1/admin/mail-recipients
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '../services/api';

export interface MailRecipient {
  recipient_id: number;
  email: string;
  source: 'admin' | 'pananora' | string;
  notify_enabled: boolean;
  description: string | null;
  created_at: string | null;
  created_by: string | null;
}

const KEY = ['mail-recipients'] as const;

export function useMailRecipients() {
  return useQuery({
    queryKey: KEY,
    queryFn: async () => {
      const r = await api.get<MailRecipient[]>('/admin/mail-recipients');
      return Array.isArray(r.data) ? r.data : [];
    },
    staleTime: 15_000,
  });
}

export function useCreateMailRecipient() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { email: string; description?: string; notify_enabled?: boolean }) => {
      const r = await api.post<MailRecipient>('/admin/mail-recipients', body);
      return r.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useUpdateMailRecipient() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: number; patch: { notify_enabled?: boolean; description?: string } }) => {
      const r = await api.patch<MailRecipient>(`/admin/mail-recipients/${id}`, patch);
      return r.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useDeleteMailRecipient() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const r = await api.delete(`/admin/mail-recipients/${id}`);
      return r.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
