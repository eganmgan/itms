import { useLayoutEffect, useRef, type ComponentProps } from 'react'
import { Modal } from './ui'

// Keep the existing visual dialog, with scoped keyboard/focus handling for
// endpoint confirmations. Never initially focus the destructive submit button.
export function EndpointActionDialog({ children, onClose, ...props }: ComponentProps<typeof Modal>) {
  const content = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  useLayoutEffect(() => { close.current = onClose }, [onClose])
  useLayoutEffect(() => {
    const dialog = content.current?.closest<HTMLElement>('[role="dialog"]')
    const previous = document.activeElement
    if (!dialog) return
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]'))
    focusable()[0]?.focus()
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current(); return }
      if (event.key !== 'Tab') return
      const targets = focusable()
      const first = targets[0], last = targets.at(-1)
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first?.focus() }
    }
    dialog.addEventListener('keydown', keydown)
    return () => {
      dialog.removeEventListener('keydown', keydown)
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])
  return <Modal {...props} onClose={onClose}><div ref={content}>{children}</div></Modal>
}