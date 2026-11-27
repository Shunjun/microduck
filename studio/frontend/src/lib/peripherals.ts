import type { DeviceOption } from '../components/DevicePicker'

export interface PeripheralValues {
  microphone_device: string
  speaker_device: string
  camera_device: string
  speaker_volume: number
  camera_quality: string
}

export interface Peripherals extends PeripheralValues {
  microphones: DeviceOption[]
  speakers: DeviceOption[]
  cameras: DeviceOption[]
  camera_port_override: boolean
  speaker_volume_applies: boolean
  restart_units: string[]
  notices: string[]
}

export const cameraQualities: [string, string][] = [
  ['1080p30', '1920 × 1080 · 30 fps'],
  ['720p30', '1280 × 720 · 30 fps'],
  ['720p15', '1280 × 720 · 15 fps'],
  ['360p30', '640 × 360 · 30 fps'],
]

export function deviceChoices(options: DeviceOption[], saved: string): DeviceOption[] {
  const entries = new Map<string, DeviceOption>([['none', { id: 'none', label: '无', available: true }]])
  for (const option of options) entries.set(option.id, { ...option, label: option.id === 'none' ? '无' : option.id === 'default' ? '系统默认' : option.label })
  if (saved && !entries.has(saved)) entries.set(saved, { id: saved, label: saved, available: false })
  return [...entries.values()]
}

export function peripheralUpdate(draft: PeripheralValues, saved: PeripheralValues & { camera_port_override: boolean }, cameraSelected = false): Partial<PeripheralValues> {
  const values = { ...draft }
  for (const key of ['microphone_device', 'speaker_device', 'camera_device'] as const) {
    values[key] = draft[key].trim()
    if (!values[key] || /[\r\n\0]/.test(values[key])) throw Error('请选择设备，停用时请选择「无」')
  }
  if (!Number.isInteger(values.speaker_volume) || values.speaker_volume < 0 || values.speaker_volume > 100)
    throw Error('扬声器音量应为 0～100 的整数')
  if (!cameraQualities.some(([quality]) => quality === values.camera_quality)) throw Error('请选择支持的摄像头画质')
  if (saved.camera_port_override && values.camera_device !== saved.camera_device)
    throw Error('摄像头设备已被启动参数锁定')
  const changed: Partial<PeripheralValues> = {}
  if (values.microphone_device !== saved.microphone_device) changed.microphone_device = values.microphone_device
  if (values.speaker_device !== saved.speaker_device) changed.speaker_device = values.speaker_device
  if (!saved.camera_port_override && (cameraSelected || values.camera_device !== saved.camera_device)) changed.camera_device = values.camera_device
  if (values.speaker_volume !== saved.speaker_volume) changed.speaker_volume = values.speaker_volume
  if (values.camera_quality !== saved.camera_quality) changed.camera_quality = values.camera_quality
  return changed
}
