import { useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { Hardware } from '@/lib/model'
import { HardwareForm } from './HardwareForm'
import { PeripheralSettings } from './PeripheralSettings'
import { Button } from './ui/button'
import { useFeedback } from './StudioUI'

export interface SettingsSectionHandle {
  prepareSave: () => () => Promise<void>
  refresh: () => Promise<void>
  isDirty: () => boolean
}

interface HardwareSettingsProps {
  info: Hardware
  refresh: () => Promise<void>
}

export function HardwareSettings({ info, refresh }: HardwareSettingsProps) {
  const hardware = useRef<SettingsSectionHandle>(null)
  const peripherals = useRef<SettingsSectionHandle>(null)
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const { act, confirm } = useFeedback()
  async function reload() {
    const sections = [hardware.current, peripherals.current].filter((section) => section !== null)
    if (sections.some((section) => section.isDirty()) &&
      !(await confirm('刷新硬件配置？', '尚未保存的修改将被丢弃，重新读取硬件配置和设备列表。'))) return
    setBusy(true)
    await act(async () => {
      await refresh()
      if (peripherals.current) await peripherals.current.refresh()
      setRevision((value) => value + 1)
    })
    setBusy(false)
  }
  async function save() {
    setBusy(true)
    await act(async () => {
      if (!hardware.current || !peripherals.current) throw Error('设备配置尚未读取完成，请稍后重试。')
      const sections = [hardware.current, peripherals.current]
      const commits = sections.map((section) => section.prepareSave())
      try {
        for (const commit of commits) await commit()
      } catch (error) {
        throw Error('保存未全部完成，部分配置可能已保存。请重试。' + (error instanceof Error ? error.message : String(error)))
      }
      for (const section of sections) await section.refresh()
    }, '硬件配置已保存。请按页面提示重启相关服务后生效。')
    setBusy(false)
  }
  return (
    <fieldset disabled={busy} className="flex min-w-0 flex-col gap-5">
      <HardwareForm key={[info.configured_driver, info.configured_port, info.normal_p, info.limp_p, revision].join('|')} info={info} refresh={refresh} ref={hardware} onSave={() => void save()} />
      <PeripheralSettings ref={peripherals} onSave={() => void save()} />
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => void save()}>保存硬件配置</Button>
        <Button variant="outline" disabled={busy} onClick={() => void reload()}><RefreshCw data-icon="inline-start" />刷新</Button>
      </div>
    </fieldset>
  )
}
