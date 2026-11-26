import { useRef, type KeyboardEvent, type PointerEvent } from 'react'

type Props = {
  label: string
  value: number
  min: number
  max: number
  direction: 1 | -1
  onResize: (width: number) => void
  className?: string
}

export function ChatResizeHandle({ label, value, min, max, direction, onResize, className = '' }: Props) {
  const drag = useRef<{ pointerId: number; x: number; width: number } | null>(null)
  const resize = (width: number) => onResize(Math.max(min, Math.min(max, width)))

  function start(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    event.preventDefault()
    drag.current = { pointerId: event.pointerId, x: event.clientX, width: value }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function move(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId === event.pointerId) resize(drag.current.width + direction * (event.clientX - drag.current.x))
  }

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      resize(value + direction * (event.key === 'ArrowRight' ? 20 : -20))
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      resize(event.key === 'Home' ? min : max)
    }
  }

  return <div role="separator" aria-label={label} aria-orientation="vertical" aria-valuemin={min} aria-valuemax={max} aria-valuenow={Math.round(value)} tabIndex={0} title={`${label} (drag or use arrow keys)`} className={`touch-none cursor-col-resize items-center justify-center focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600 ${className}`} onPointerDown={start} onPointerMove={move} onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }} onLostPointerCapture={() => { drag.current = null }} onKeyDown={keyDown}>
    <span aria-hidden="true" className="h-10 w-1 rounded-full bg-slate-400/70" />
  </div>
}
