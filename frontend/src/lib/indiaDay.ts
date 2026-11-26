import { useEffect, useState } from 'react'

const indiaOffsetMs = 330 * 60 * 1000
const dayMs = 24 * 60 * 60 * 1000

export function indiaDay(timestamp: number): number {
  return Math.floor((timestamp + indiaOffsetMs) / dayMs)
}

export function useIndiaDay(): number {
  const [day, setDay] = useState(() => indiaDay(Date.now()))
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const update = () => {
      clearTimeout(timer)
      const now = Date.now()
      const currentDay = indiaDay(now)
      setDay(currentDay)
      timer = setTimeout(update, (currentDay + 1) * dayMs - indiaOffsetMs - now + 50)
    }
    update()
    window.addEventListener('focus', update)
    return () => { clearTimeout(timer); window.removeEventListener('focus', update) }
  }, [])
  return day
}
