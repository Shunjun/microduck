import { useCallback, useEffect, useRef, useState } from 'react'
import { debug, message, robot, useConnected } from './api'
import type { DebugState, Hardware } from './model'

export function useHardware() {
  const ready = useConnected()
  const [info, setInfo] = useState<Hardware | null>(null)
  const [error, setError] = useState('')
  const generation = useRef(0)
  const refresh = useCallback(async () => {
    const token = ++generation.current
    try {
      const value = await robot.request<Hardware>('robot.hardware')
      if (generation.current === token) {
        setInfo(value)
        setError('')
      }
    } catch (cause) {
      if (generation.current === token) setError(message(cause))
    }
  }, [])
  useEffect(() => {
    if (!ready) {
      ++generation.current
      setInfo(null)
      setError('')
      return
    }
    void refresh()
    const timer = setInterval(refresh, 2500)
    return () => {
      ++generation.current
      clearInterval(timer)
    }
  }, [ready, refresh])
  return { info, error, refresh }
}

export function useDebug() {
  const [state, setState] = useState<DebugState | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [fresh, setFresh] = useState(false)
  const locked = useRef(false)
  const version = useRef(0)
  const live = useRef(false)
  const lastSample = useRef({ stamp: -1, at: 0 })
  const apply = useCallback((data: DebugState) => {
    if (!live.current) return
    if (lastSample.current.stamp !== data.sampled_ms)
      lastSample.current = { stamp: data.sampled_ms, at: Date.now() }
    setFresh(data.active && Date.now() - lastSample.current.at < 1500)
    setState(data)
    window.dispatchEvent(new CustomEvent('studio-debug-state', { detail: data }))
  }, [])
  useEffect(() => {
    live.current = true
    let timer = 0
    async function poll() {
      if (!locked.current && !document.hidden) {
        const stamp = version.current
        try {
          const data = await debug('status')
          if (stamp === version.current) {
            apply(data)
            if (live.current) setError('')
          }
        } catch (cause) {
          if (live.current && stamp === version.current) {
            setError(message(cause))
            setFresh(false)
            setState(null)
          }
        }
      }
      if (live.current) timer = window.setTimeout(poll, 400)
    }
    void poll()
    return () => {
      live.current = false
      ++version.current
      clearTimeout(timer)
    }
  }, [apply])
  async function run(op: string, fields: Record<string, unknown> = {}) {
    if (locked.current) throw Error('请等待当前操作完成')
    locked.current = true
    ++version.current
    setBusy(true)
    try {
      const data = await debug(op, fields)
      apply(data)
      return data
    } finally {
      locked.current = false
      if (live.current) setBusy(false)
    }
  }
  return { state, error, busy, fresh, run }
}
export type DebugSession = ReturnType<typeof useDebug>
