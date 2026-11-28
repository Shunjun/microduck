import type { DebugState, Hardware, Joint } from './model'

// FT-SCS: bit 15 is direction; 4096 ticks still represent one revolution.
export const POSITION_MIN_TICKS = -32767
export const POSITION_MAX_TICKS = 32767
export function jointLimits(joint: Joint) {
  return (
    (joint.direction === 1 || joint.direction === -1) &&
    Number.isInteger(joint.min_ticks) &&
    Number.isInteger(joint.max_ticks) &&
    joint.min_ticks! >= POSITION_MIN_TICKS &&
    joint.max_ticks! <= POSITION_MAX_TICKS &&
    joint.min_ticks! < joint.max_ticks!
  )
}
export function reusablePose(state: DebugState) {
  return (
    !state.candidate &&
    state.settings.length === 15 &&
    state.settings.every(
      (j) =>
        jointLimits(j) &&
        j.zero_ticks !== null &&
        Number.isInteger(j.zero_ticks) &&
        j.zero_ticks >= POSITION_MIN_TICKS &&
        j.zero_ticks <= POSITION_MAX_TICKS,
    )
  )
}

export function reusableImu(state: DebugState) {
  const mount = state.imu_mount
  return (
    !state.imu_candidate &&
    !!mount &&
    mount.length === 4 &&
    mount.every(Number.isFinite) &&
    Math.abs(mount.reduce((sum, x) => sum + x * x, 0) - 1) <= 1e-6
  )
}

export function debugPose(state: DebugState, fresh: boolean) {
  let measured = 0
  const angles = state.settings.map((joint, index) => {
    const reading = state.readings.find((r) => r.id === joint.id)
    if (reading?.ticks == null || reading.error || !joint.direction || joint.zero_ticks == null)
      return state.reference[index]
    measured++
    return ((reading.ticks - joint.zero_ticks) * joint.direction * 2 * Math.PI) / 4096
  })
  const label = !fresh
    ? '等待新鲜回读'
    : measured === 15
      ? '实测姿态'
      : '实测 ' + measured + ' / 15 · 其余关节显示标准参照'
  return { angles, label }
}

export function finishProblems(state: DebugState) {
  const problems: string[] = []
  if (!reusablePose(state)) problems.push('请先应用 15 个关节的方向与限位，采集并保存标准姿态。')
  if (!reusableImu(state)) problems.push('请确认安装方向，并独立保存身体 IMU 标定。')
  if (!(Number.isFinite(state.speed_rad_s_per_unit) && Number(state.speed_rad_s_per_unit) > 0))
    problems.push('缺少已确认的速度换算值（rad/s 每原始单位）。')
  if (!(Number.isFinite(state.current_ma_per_unit) && Number(state.current_ma_per_unit) > 0))
    problems.push('缺少已确认的电流换算值（mA 每原始单位）。')
  return problems
}

// A newly opened commissioning tty is waiting until the first explicit debug read.
export function canStartServoCheck(info: Hardware | null) {
  return !!info && !info.restart_required && info.bus_status !== 'reconfiguring'
}

export function canEditZero(state: DebugState, joint: Joint) {
  return state.active && state.mode === 'off' && !state.moving && joint.zero_ticks != null
}
