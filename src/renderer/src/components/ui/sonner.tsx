import * as React from 'react'
import { Toaster as Sonner } from 'sonner'
import { useTheme } from '@renderer/components/theme-provider'

type ToasterProps = React.ComponentProps<typeof Sonner>

function Toaster({ ...props }: ToasterProps): React.JSX.Element {
  const { theme } = useTheme()

  return (
    <Sonner
      theme={theme}
      position="bottom-right"
      toastOptions={{
        classNames: {
          toast: 'bg-popover text-popover-foreground border-border',
          description: 'text-muted-foreground',
          actionButton: 'bg-primary text-primary-foreground',
          cancelButton: 'bg-muted text-muted-foreground',
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
