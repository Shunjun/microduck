import { useEffect, useId, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { RefreshCw } from 'lucide-react'
import { robot, useConnected, message } from '@/lib/api'
import { cameraQualities, deviceChoices, peripheralUpdate, type Peripherals, type PeripheralValues } from '@/lib/peripherals'
import type { SettingsSectionHandle } from '@/components/HardwareSettings'
import type { DeviceOption } from '@/components/DevicePicker'
import { Choice, Panel, Problem, useFeedback } from '@/components/StudioUI'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Slider } from '@/components/ui/slider'

interface PeripheralFormProps {
  info: Peripherals
  onSaved: (info: Peripherals) => void
  refresh: () => Promise<void>
  ref?: Ref<SettingsSectionHandle>
  onSave?: () => void
}

interface PeripheralSettingsProps {
  ref?: Ref<SettingsSectionHandle>
  onSave?: () => void
}

function selectionOptions(options: DeviceOption[], saved: string): [string, string][] {
  return deviceChoices(options, saved).map((option) => [
    option.id,
    option.label + (option.available ? '' : '（未检测到或不可访问）'),
  ])
}

function PeripheralForm({ info, onSaved, refresh, ref, onSave }: PeripheralFormProps) {
  const [draft, setDraft] = useState<PeripheralValues>(() => ({
    microphone_device: info.microphone_device,
    speaker_device: info.speaker_device,
    camera_device: info.camera_device,
    speaker_volume: info.speaker_volume,
    camera_quality: info.camera_quality,
  }))
  const [busy, setBusy] = useState(false)
  const [cameraSelected, setCameraSelected] = useState(false)
  const { act, confirm } = useFeedback()
  const volumeId = useId()
  function change<K extends keyof PeripheralValues>(key: K, value: PeripheralValues[K]) {
    if (key === 'camera_device') setCameraSelected(true)
    setDraft((current) => ({ ...current, [key]: value }))
  }
  function prepareSave() {
    const update = peripheralUpdate(draft, info, cameraSelected)
    return async () => {
      if (Object.keys(update).length === 0) return
      onSaved(await robot.request<Peripherals>('robot.setPeripherals', update))
    }
  }
  const dirty = cameraSelected || (Object.keys(draft) as (keyof PeripheralValues)[]).some((key) => draft[key] !== info[key])
  useImperativeHandle(ref, () => ({ prepareSave, refresh, isDirty: () => dirty }))
  async function save() {
    setBusy(true)
    await act(async () => {
      await prepareSave()()
    }, '设备配置已保存。请按下方提示重启相关服务后生效。')
    setBusy(false)
  }
  async function reload() {
    if (dirty && !(await confirm('重新读取设备配置？', '尚未保存的设备选择将被丢弃。'))) return
    setBusy(true)
    await act(refresh)
    setBusy(false)
  }
  return (
    <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); if (onSave) onSave(); else void save() }}>
      <Panel title="麦克风" description="选择录音设备；选择「无」后不采集声音，不影响扬声器播放。">
        <FieldGroup>
          <Choice label="录音设备" value={draft.microphone_device} onChange={(value) => change('microphone_device', value)} options={selectionOptions(info.microphones, draft.microphone_device)} disabled={busy} />
          <p className="text-xs text-muted-foreground">列表来自设备所在主控。未检测到声卡时，需要先完成系统音频配置。</p>
        </FieldGroup>
      </Panel>
      <Panel title="扬声器" description="选择播放设备；选择「无」后不输出声音，不影响麦克风采集。">
        <FieldGroup>
          <Choice label="播放设备" value={draft.speaker_device} onChange={(value) => change('speaker_device', value)} options={selectionOptions(info.speakers, draft.speaker_device)} disabled={busy} />
          <Field data-disabled={draft.speaker_device === 'none' || busy || undefined}>
            <FieldLabel htmlFor={volumeId}>扬声器音量 <output className="ml-auto tabular-nums">{draft.speaker_volume}%</output></FieldLabel>
            <Slider id={volumeId} aria-label="扬声器音量" value={[draft.speaker_volume]} onValueChange={([volume]) => change('speaker_volume', volume)} min={0} max={100} step={1} disabled={draft.speaker_device === 'none' || busy} />
            <FieldDescription>{!info.speaker_volume_applies && draft.speaker_device !== 'none' ? '当前保存的设备没有应用可控制的音量接口，音量值仅保存，实际音量需由系统声卡设置。' : '设备选择「无」会关闭播放通路；音量为 0 只代表静音。'}</FieldDescription>
          </Field>
        </FieldGroup>
      </Panel>
      <Panel title="摄像头" description="选择视频采集设备；选择「无」后不打开摄像头，也不会替换成测试画面。">
        <FieldGroup>
          <Choice label="视频设备" value={draft.camera_device} onChange={(value) => change('camera_device', value)} options={selectionOptions(info.cameras, draft.camera_device)} disabled={info.camera_port_override || busy} />
          {info.camera_port_override && <p className="text-xs text-muted-foreground">视频设备已被 mediad 的 --camera-device 启动参数锁定。</p>}
          <Choice label="视频画质" value={draft.camera_quality} onChange={(value) => change('camera_quality', value)} options={cameraQualities} disabled={draft.camera_device === 'none' || busy} />
          <p className="text-xs text-muted-foreground">帧率是目标输出规格，实际效果取决于摄像头、驱动和编码性能。网页自动连接本设备的视频服务。</p>
        </FieldGroup>
      </Panel>
      {!onSave && <div className="flex flex-wrap gap-2">
        {!onSave && <Button type="submit" disabled={busy}>保存设备配置</Button>}
        <Button type="button" variant="outline" disabled={busy} onClick={() => void reload()}><RefreshCw data-icon="inline-start" />刷新设备</Button>
      </div>}
      <div className="flex flex-col gap-2 text-sm text-muted-foreground" role="status">
        {info.restart_units.length > 0 && <p>需要重启的服务：<span className="font-mono">{info.restart_units.join('、')}</span>。</p>}
        {info.notices.map((notice) => <p key={notice}>{notice}</p>)}
      </div>
    </form>
  )
}

export function PeripheralSettings({ ref, onSave }: PeripheralSettingsProps) {
  const form = useRef<SettingsSectionHandle>(null)
  const ready = useConnected()
  const [info, setInfo] = useState<Peripherals | null>(null)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let live = true
    setInfo(null)
    setError('')
    if (ready) robot.request<Peripherals>('robot.peripherals').then((result) => {
      if (live) setInfo(result)
    }).catch((cause) => { if (live) setError(message(cause)) })
    return () => { live = false }
  }, [ready])
  async function refresh() {
    setError('')
    try {
      const result = await robot.request<Peripherals>('robot.peripherals')
      setInfo(result)
      setRevision((value) => value + 1)
    } catch (cause) {
      setError(message(cause))
      throw cause
    }
  }
  useImperativeHandle(ref, () => ({
    prepareSave: () => {
      if (!form.current) throw Error('音视频设备配置尚未读取完成，请刷新后重试。')
      return form.current.prepareSave()
    },
    refresh,
    isDirty: () => form.current?.isDirty() ?? false,
  }))
  return (
    <div className="flex flex-col gap-3">
      <Problem>{error}</Problem>
      {error && !onSave && <Button variant="outline" className="self-start" onClick={() => void refresh().catch(() => {})}>重新读取设备</Button>}
      {!info && !error && <p className="text-sm text-muted-foreground">{ready ? '正在读取麦克风、扬声器和摄像头配置…' : '连接运行端后可设置音频与摄像头设备。'}</p>}
      {info && <PeripheralForm key={[info.microphone_device, info.speaker_device, info.camera_device, info.speaker_volume, info.camera_quality, revision].join('|')} info={info} onSaved={(saved) => { setInfo(saved); setRevision((value) => value + 1) }} refresh={refresh} ref={form} onSave={onSave} />}
    </div>
  )
}
