import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      gcTime: 5 * 60_000,
      retry: (failureCount, error) => {
        const status = (error as { response?: { status?: number } } | null)?.response?.status;
        if (status === 401 || status === 403 || status === 404) return false;
        return failureCount < 2;
      },
      refetchOnWindowFocus: true,
    },
    mutations: {
      retry: false,
    },
  },
});

export const queryKeys = {
  edges: {
    all: ['edges'] as const,
    list: () => [...queryKeys.edges.all, 'list'] as const,
    detail: (edgeId: string) => [...queryKeys.edges.all, 'detail', edgeId] as const,
    configSync: (edgeId: string) => [...queryKeys.edges.all, 'config-sync', edgeId] as const,
  },
  devices: {
    all: ['devices'] as const,
    list: (filters?: { edgeId?: string; kind?: string }) =>
      [...queryKeys.devices.all, 'list', filters ?? {}] as const,
    detail: (deviceId: string) => [...queryKeys.devices.all, 'detail', deviceId] as const,
  },
  deviceModels: {
    all: ['device-models'] as const,
    list: () => [...queryKeys.deviceModels.all, 'list'] as const,
    circuits: (modelId: number) => [...queryKeys.deviceModels.all, modelId, 'circuits'] as const,
  },
  ecsu: {
    all: ['ecsu'] as const,
    list: () => [...queryKeys.ecsu.all, 'list'] as const,
    assgn: (ecsuId: number) => [...queryKeys.ecsu.all, ecsuId, 'assgn'] as const,
  },
  billing: {
    all: ['billing'] as const,
    list: (kind: string) => [...queryKeys.billing.all, 'list', kind] as const,
  },
  electricParameters: {
    all: ['electric-parameters'] as const,
    list: () => [...queryKeys.electricParameters.all, 'list'] as const,
  },
  reports: {
    all: ['reports'] as const,
    energy: (params: Record<string, unknown>) => [...queryKeys.reports.all, 'energy', params] as const,
    thermal: (params: Record<string, unknown>) => [...queryKeys.reports.all, 'thermal', params] as const,
    events: (params: Record<string, unknown>) => [...queryKeys.reports.all, 'events', params] as const,
  },
  dashboard: {
    all: ['dashboard'] as const,
    summary: () => [...queryKeys.dashboard.all, 'summary'] as const,
  },
} as const;
