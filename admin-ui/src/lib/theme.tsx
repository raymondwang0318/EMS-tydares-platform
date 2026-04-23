/**
 * V2-final 主題 context + ThemeProvider。
 *
 * - 主色 colorPrimary = #4caf50（Material Design green-500；老王 2026-04-22 bless
 *   via M-PM-021）。與既有 Sidebar palette `#e8f5e9 / #c8e6c9 / #a5d6a7`（MD
 *   green-50/100/300）同色階，green-500 為中間鍵。
 * - 預設 light mode；dark mode 留 hook，不寫死切換 UI（後續 Phase 再加）。
 * - localStorage key = `ems_theme_mode`（P11 提議，M-PM-021 採納）。
 *
 * 依 T-P11-002 AC 5「主題切換機制留 hook，不寫死」。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ConfigProvider, theme as antdTheme } from 'antd';

export type ThemeMode = 'light' | 'dark';

const STORAGE_KEY = 'ems_theme_mode';
const PRIMARY = '#4caf50';

interface ThemeContextValue {
  mode: ThemeMode;
  setMode: (m: ThemeMode) => void;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used within <ThemeProvider>');
  }
  return ctx;
}

function readStoredMode(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(readStoredMode);

  const setMode = useCallback((m: ThemeMode) => {
    setModeState(m);
    try {
      localStorage.setItem(STORAGE_KEY, m);
    } catch {
      /* ignore quota / privacy mode */
    }
  }, []);

  const toggle = useCallback(() => {
    setModeState((prev) => {
      const next: ThemeMode = prev === 'light' ? 'dark' : 'light';
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  useEffect(() => {
    // 外部（例：其他分頁）改 localStorage 時同步
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY && (e.newValue === 'light' || e.newValue === 'dark')) {
        setModeState(e.newValue);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const value = useMemo<ThemeContextValue>(() => ({ mode, setMode, toggle }), [mode, setMode, toggle]);

  const algorithm = mode === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm;

  return (
    <ThemeContext.Provider value={value}>
      <ConfigProvider
        theme={{
          algorithm,
          token: {
            colorPrimary: PRIMARY,
            colorLink: PRIMARY,
            borderRadius: 6,
          },
          components: {
            Menu: {
              // 淺色 mode 下保留既有 Sidebar palette；darkAlgorithm 會自動覆寫
              itemBg: mode === 'light' ? '#e8f5e9' : undefined,
              itemColor: mode === 'light' ? '#000000' : undefined,
              itemHoverBg: mode === 'light' ? '#c8e6c9' : undefined,
              itemSelectedBg: mode === 'light' ? '#a5d6a7' : undefined,
              itemSelectedColor: mode === 'light' ? '#000000' : undefined,
              subMenuItemBg: mode === 'light' ? '#e8f5e9' : undefined,
              popupBg: mode === 'light' ? '#e8f5e9' : undefined,
            },
          },
        }}
      >
        {children}
      </ConfigProvider>
    </ThemeContext.Provider>
  );
}
