import type { DebugState } from './model'

export const demoDegrees = (index: number) => index === 9 ? 5 : 10
export function servoResponseCount(state: Pick<DebugState, 'readings'> | null) {
  return state?.readings.filter(r => Number.isInteger(r.ticks) && !r.error).length ?? 0
}
export function referenceOffsetDegrees(ticks: number | null | undefined, reference: number | null | undefined, direction: number | null | undefined) {
  if (ticks == null || reference == null || (direction !== 1 && direction !== -1)) return null
  return ((ticks - reference) * direction * 360) / 4096
}
export function observedDirection(reference: number, positive: number | undefined, negative: number | undefined, index = 0) {
  if (positive == null || negative == null) return null
  const p = positive - reference, n = negative - reference
  const step = demoDegrees(index) * 4096 / 360
  if (Math.sign(p) === Math.sign(n) || [p, n].some(v => Math.abs(v) < step * .4 || Math.abs(v) > step * 2)) return null
  return p > 0 ? 1 : -1
}
export function demoPose(reference: number[], index: number, fraction: number) {
  const result = [...reference]
  result[index] += fraction * demoDegrees(index) * Math.PI / 180
  return result
}
export function guidedJointsReady(state: DebugState | null) {
  return !!state && state.joint_calibrated.length === 15 && state.joint_calibrated.every(Boolean)
}
