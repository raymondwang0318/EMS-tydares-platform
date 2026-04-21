const TOKEN_STORAGE_KEY = 'ems_admin_token';

export function getToken(): string | null {
  const stored = localStorage.getItem(TOKEN_STORAGE_KEY);
  if (stored) return stored;
  return import.meta.env.VITE_API_TOKEN || 'CHANGE_ME';
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_STORAGE_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
}

export function isAuthenticated(): boolean {
  return getToken() !== null;
}
