export interface Hardware {
  active_driver: string
  configured_driver: string
  restart_required: boolean
  configured_port: string
  effective_port: string
  port_override: boolean
  ports: { path: string; accessible: boolean }[]
  normal_p: number
  limp_p: number
  bus_status: string
  bus_error: string | null
  calibration_required: boolean
  calibration_error: string | null
}

export interface Joint {
  id: number
  direction: number | null
  min_ticks: number | null
  max_ticks: number | null
  zero_ticks: number | null
}

export interface Reading {
  id: number
  ticks: number | null
  p: number | null
  voltage: number | null
  temperature: number | null
  torque: boolean | null
  current_raw: number | null
  error: string | null
}

export interface DebugState {
  active: boolean
  simulated: boolean
  mode: 'off' | 'hold' | 'follow'
  p: number
  names: string[]
  reference: number[]
  settings: Joint[]
  readings: Reading[]
  candidate: Joint[] | null
  sampled_ms: number
  error: string | null
  saved: string | null
  moving: boolean
  imu: { gyro: number[] } | null
  imu_error: string | null
  imu_mount: number[] | null
  imu_candidate: number[] | null
  speed_rad_s_per_unit?: number | null
  current_ma_per_unit?: number | null
  calibration_required: boolean
  calibration_error: string | null
}

export interface Frame {
  joints: number[]
  imu?: { quat: number[] }
  policy: string
  move: { source?: string; limited_by: string[] }
  safety: { fallen: boolean; picked_up: boolean; limp: boolean }
}

export interface Health {
  healthy: boolean
  degraded?: boolean
  battery?: { percent: number; volts: number }
  imu?: { ready: boolean; missing: boolean; consecutive_stale_blocks: number }
}

export interface Manifest {
  name: string
  description?: string
  kind: string
  duration_s?: number | null
  slot?: string
  command: { idle: unknown; encoding?: string }
  unwind_s?: number
  chain?: unknown
  action_scale?: unknown
  [key: string]: unknown
}
export interface Entry {
  id: string
  path: string
  bytes: number
  manifest: Manifest
}
export interface Skills {
  skills: { name: string; duration?: number; overridden: boolean }[]
  built_in?: string[]
}
export interface Policy {
  slot: string
  path: string | null
  overridden?: boolean
  error?: string
}

export interface Policies { enabled: boolean; skills?: string[]; slots: Policy[] }
