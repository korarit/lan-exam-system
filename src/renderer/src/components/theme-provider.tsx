import * as React from 'react'

export type Theme = 'dark' | 'light'

interface ThemeContextValue {
  theme: Theme
  setTheme: (theme: Theme) => void
  toggleTheme: () => void
}

const ThemeContext = React.createContext<ThemeContextValue | null>(null)

export const THEME_STORAGE_KEY = 'zt-theme'

function readStoredTheme(): Theme {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

function applyTheme(theme: Theme): void {
  const root = document.documentElement
  root.classList.toggle('dark', theme === 'dark')
  root.style.colorScheme = theme
}

// กัน flash: เติม class ตั้งแต่ module load (ก่อน first paint) — default dark
if (typeof document !== 'undefined') {
  applyTheme(readStoredTheme())
}

export function ThemeProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [theme, setThemeState] = React.useState<Theme>(() => readStoredTheme())

  const setTheme = React.useCallback((next: Theme) => {
    setThemeState(next)
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next)
    } catch {
      // localStorage ใช้ไม่ได้ (เช่น kiosk lockdown) — คง theme ใน memory
    }
    applyTheme(next)
  }, [])

  const toggleTheme = React.useCallback(() => {
    setThemeState((prev) => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark'
      try {
        window.localStorage.setItem(THEME_STORAGE_KEY, next)
      } catch {
        // ignore — ดู comment ใน setTheme
      }
      applyTheme(next)
      return next
    })
  }, [])

  // ซิงก์ class อีกครั้งหลัง mount (กันกรณี DOM ถูกแตะจากภายนอกก่อน React render)
  React.useEffect(() => {
    applyTheme(theme)
  }, [theme])

  const value = React.useMemo(() => ({ theme, setTheme, toggleTheme }), [theme, setTheme, toggleTheme])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const ctx = React.useContext(ThemeContext)
  if (ctx === null) {
    throw new Error('useTheme ต้องใช้ภายใน <ThemeProvider>')
  }
  return ctx
}
