import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import { robot } from '@/lib/api'
import { normalize, velocityFor, type Preferences } from '@/lib/motion'
import { useFeedback } from './StudioUI'

export function Joystick({
  speed,
  prefs,
  enabled,
}: {
  speed: number
  prefs: Preferences
  enabled: boolean
}) {
  const [point, setPoint] = useState({ x: 0, y: 0 })
  const current = useRef(point)
  const held = useRef(false)
  const pointer = useRef<number | null>(null)
  const keys = useRef(new Set<string>())
  const limits = useRef({ speed, prefs, enabled })
  limits.current = { speed, prefs, enabled }
  const { notify } = useFeedback()
  const stop = useCallback(() => {
    const moving = held.current
    held.current = false
    pointer.current = null
    keys.current.clear()
    if (moving) {
      current.current = { x: 0, y: 0 }
      setPoint(current.current)
      robot.notify('robot.move', { vx: 0, vy: 0, vyaw: 0 })
    }
  }, [])
  const send = useCallback(() => {
    if (!held.current) return
    if (!limits.current.enabled || !robot.fresh() || document.visibilityState !== 'visible') {
      stop()
      return
    }
    const { x, y } = current.current
    robot.notify('robot.move', velocityFor(x, y, limits.current.speed, limits.current.prefs))
  }, [stop])
  useEffect(() => {
    const interval = setInterval(send, 50)
    window.addEventListener('blur', stop)
    window.addEventListener('studio-stop', stop)
    window.addEventListener('pagehide', stop)
    document.addEventListener('visibilitychange', stop)
    robot.addEventListener('connection', stop)
    return () => {
      stop()
      clearInterval(interval)
      window.removeEventListener('blur', stop)
      window.removeEventListener('pagehide', stop)
      window.removeEventListener('studio-stop', stop)
      document.removeEventListener('visibilitychange', stop)
      robot.removeEventListener('connection', stop)
    }
  }, [send, stop])
  function move(x: number, y: number) {
    current.current = normalize(x, y)
    setPoint(current.current)
    send()
  }
  function fromPointer(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerId !== pointer.current) return
    const rect = event.currentTarget.getBoundingClientRect()
    move(
      (event.clientX - rect.left - rect.width / 2) / (rect.width * 0.4),
      (event.clientY - rect.top - rect.height / 2) / (rect.height * 0.4),
    )
  }
  function key(event: KeyboardEvent<HTMLDivElement>) {
    if (
      !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key) ||
      pointer.current !== null
    )
      return
    event.preventDefault()
    if (!enabled || !robot.fresh()) {
      stop()
      return
    }
    if (event.type === 'keydown') {
      if (event.repeat && !keys.current.has(event.key)) return
      keys.current.add(event.key)
    } else keys.current.delete(event.key)
    if (!keys.current.size) {
      stop()
      return
    }
    held.current = true
    const pressed = (key: string) => Number(keys.current.has(key))
    move(pressed('ArrowRight') - pressed('ArrowLeft'), pressed('ArrowDown') - pressed('ArrowUp'))
  }
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div
        role="application"
        tabIndex={0}
        aria-label="移动摇杆，上下前后，左右转向"
        className="relative size-28 touch-none select-none rounded-full border border-input bg-muted text-xs text-muted-foreground shadow-inner outline-ring focus-visible:outline-2 lg:size-[clamp(110px,21dvh,178px)]"
        onPointerDown={(e) => {
          if (e.button !== 0 || held.current) return
          if (!enabled || !robot.fresh()) {
            notify('等待实时设备状态后才能移动', true)
            return
          }
          held.current = true
          pointer.current = e.pointerId
          e.currentTarget.setPointerCapture(e.pointerId)
          fromPointer(e)
        }}
        onPointerMove={fromPointer}
        onPointerCancel={stop}
        onPointerUp={stop}
        onLostPointerCapture={stop}
        onKeyDown={key}
        onKeyUp={key}
        onBlur={stop}
      >
        <span className="absolute inset-y-4 left-1/2 border-l border-input" />
        <span className="absolute inset-x-4 top-1/2 border-t border-input" />
        <span className="absolute left-1/2 top-2 -translate-x-1/2">前</span>
        <span className="absolute bottom-2 left-1/2 -translate-x-1/2">后</span>
        <span className="absolute left-2 top-1/2 -translate-y-1/2">↶</span>
        <span className="absolute right-2 top-1/2 -translate-y-1/2">↷</span>
        <span
          style={{ left: 50 + 30 * point.x + '%', top: 50 + 30 * point.y + '%' }}
          className="pointer-events-none absolute flex size-[36%] -translate-1/2 items-center justify-center rounded-full border bg-card shadow-md"
        >
          拖动
        </span>
      </div>
      <output className="font-mono text-[10px] text-muted-foreground">
        前进 {(-point.y * speed).toFixed(1)}% · 转向 {(-point.x * speed).toFixed(1)}%
      </output>
    </div>
  )
}
