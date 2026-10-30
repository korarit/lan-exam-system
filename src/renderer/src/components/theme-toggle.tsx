import { Moon, Sun } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { useTheme } from '@renderer/components/theme-provider'

export function ThemeToggle(): React.JSX.Element {
  const { theme, toggleTheme } = useTheme()

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={toggleTheme}
      aria-label={theme === 'dark' ? 'เปลี่ยนเป็นโหมดสว่าง' : 'เปลี่ยนเป็นโหมดมืด'}
      title={theme === 'dark' ? 'โหมดมืด (คลิกเพื่อเปลี่ยนเป็นโหมดสว่าง)' : 'โหมดสว่าง (คลิกเพื่อเปลี่ยนเป็นโหมดมืด)'}
    >
      {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </Button>
  )
}
