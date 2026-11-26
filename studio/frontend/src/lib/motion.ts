export interface Preferences {
  speed: number
  forward: number
  turn: number
}
const defaults = { speed: 35, forward: 0.15, turn: 0.8 }
export function preferences(): Preferences {
  try {
    const fields = JSON.parse(localStorage.getItem('microduck.studio.preferences') || '{}')
    const read = (key: keyof Preferences, min: number, max: number) =>
      typeof fields[key] === 'number' && Number.isFinite(fields[key])
        ? Math.max(min, Math.min(max, fields[key]))
        : defaults[key]
    return {
      speed: read('speed', 0, 100),
      forward: read('forward', 0.01, 0.5),
      turn: read('turn', 0.05, 2),
    }
  } catch {
    return defaults
  }
}

export function normalize(x: number, y: number) {
  const radius = Math.max(1, Math.hypot(x, y))
  return { x: x / radius, y: y / radius }
}

export function velocityFor(x: number, y: number, speed: number, prefs: Preferences) {
  const point = normalize(x, y)
  return {
    vx: ((-point.y * speed) / 100) * prefs.forward,
    vy: 0,
    vyaw: ((-point.x * speed) / 100) * prefs.turn,
  }
}

export function unitQuaternion(quat?: number[]) {
  if (quat?.length !== 4 || !quat.every(Number.isFinite)) return undefined
  const length = Math.hypot(...quat)
  return length > 1e-6 ? quat.map((v) => v / length) : undefined
}

export const labels = [
  '左髋偏航',
  '左髋侧摆',
  '左髋俯仰',
  '左膝',
  '左踝',
  '颈部俯仰',
  '头部俯仰',
  '头部偏航',
  '头部侧摆',
  '嘴部',
  '右髋偏航',
  '右髋侧摆',
  '右髋俯仰',
  '右膝',
  '右踝',
]

export function isFeedbackFresh(connected: boolean, hasFrame: boolean, ageMs: number) {
  return connected && hasFrame && ageMs >= 0 && ageMs < 1500
}
