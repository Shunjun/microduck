import { useEffect, useState } from 'react'
import { isFeedbackFresh } from './motion'
import type { DebugState, Frame, Health } from './model'

export const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

export async function http<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: { 'x-studio': '1', ...options.headers },
  })
  const data = await response.json()
  if (!response.ok || (data.error && typeof data.active !== 'boolean'))
    throw Error(data.error || 'HTTP ' + response.status)
  return data
}

export const debug = (op: string, fields: Record<string, unknown> = {}) =>
  http<DebugState>('/api/debug', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op, ...fields }),
  })

type Pending = {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: number
  start: number
}
type Ack = { accepted?: boolean; reason?: string }
class Robot extends EventTarget {
  private socket?: WebSocket
  private pending = new Map<number, Pending>()
  private serial = 0
  ready = false
  frame: Frame | null = null
  health: Health | null = null
  frameAt = 0
  latency = 0
  fresh = () => isFeedbackFresh(this.ready, !!this.frame, performance.now() - this.frameAt)
  connect() {
    const ws = (this.socket = new WebSocket(
      location.protocol.replace('http', 'ws') + '//' + location.host + '/api/session',
    ))
    let heartbeat = 0
    ws.onopen = async () => {
      try {
        await this.request('hello', { api_version: 73, client: 'studio' })
        await this.request('robot.subscribe', { hz: 10 })
        this.ready = true
        this.dispatchEvent(new Event('connection'))
        const health = async () => {
          try {
            this.health = await this.request<Health>('robot.health')
            this.dispatchEvent(new Event('health'))
          } catch {
            /* close clears stale telemetry */
          }
        }
        void health()
        heartbeat = window.setInterval(health, 2000)
      } catch {
        ws.close()
      }
    }
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        if (data.method === 'robot.state') {
          this.frame = data.params
          this.frameAt = performance.now()
          this.dispatchEvent(new Event('frame'))
        } else if (data.method === 'studio.error') {
          this.dispatchEvent(new CustomEvent('fault', { detail: data.params.message }))
        } else {
          const pending = this.pending.get(data.id)
          if (!pending) return
          clearTimeout(pending.timer)
          this.pending.delete(data.id)
          this.latency = performance.now() - pending.start
          if (data.error || data.result?.accepted === false)
            pending.reject(Error(data.error?.message || data.result?.reason || '请求被拒绝'))
          else pending.resolve(data.result)
        }
      } catch (error) {
        this.dispatchEvent(new CustomEvent('fault', { detail: message(error) }))
      }
    }
    ws.onclose = () => {
      clearInterval(heartbeat)
      this.ready = false
      this.frame = null
      this.health = null
      for (const item of this.pending.values()) {
        clearTimeout(item.timer)
        item.reject(Error('设备连接已断开'))
      }
      this.pending.clear()
      this.dispatchEvent(new Event('connection'))
      window.setTimeout(() => this.connect(), 2500)
    }
    ws.onerror = () => ws.close()
  }
  request<T = Ack>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return new Promise((resolve, reject) => {
      if (this.socket?.readyState !== WebSocket.OPEN) {
        reject(Error('robotd 未连接'))
        return
      }
      const id = ++this.serial
      const timer = window.setTimeout(() => {
        this.pending.delete(id)
        reject(Error('请求超时'))
      }, 12000)
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
        start: performance.now(),
      })
      this.socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  }
  notify(method: string, params: Record<string, unknown>) {
    if (
      this.ready &&
      this.socket?.readyState === WebSocket.OPEN &&
      this.socket.bufferedAmount < 16384
    )
      this.socket.send(JSON.stringify({ jsonrpc: '2.0', method, params }))
  }
}
export const robot = new Robot()
export function useConnected() {
  const [ready, setReady] = useState(robot.ready)
  useEffect(() => {
    const update = () => setReady(robot.ready)
    robot.addEventListener('connection', update)
    update()
    return () => robot.removeEventListener('connection', update)
  }, [])
  return ready
}
