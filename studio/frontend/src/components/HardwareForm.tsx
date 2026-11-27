import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import type { SettingsSectionHandle } from './HardwareSettings'
import { LockKeyhole, RefreshCw } from 'lucide-react'
import { FieldGroup } from '@/components/ui/field'
import { DevicePicker } from '@/components/DevicePicker'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import type { Hardware } from '@/lib/model'
import { robot } from '@/lib/api'
import { Choice, Panel, Problem, TextField, useFeedback } from './StudioUI'
const busNames: Record<string, string> = {
  ready: '已连接',
  reconfiguring: '正在重连',
  waiting: '等待总线',
  error: '连接失败',
}

interface HardwareFormProps {
  info: Hardware
  refresh: () => Promise<void>
  wizard?: boolean
  onPending?: (pending: boolean) => void
  ref?: Ref<SettingsSectionHandle>
  onSave?: () => void
}
export function HardwareForm({ info, refresh, wizard = false, onPending, ref, onSave }: HardwareFormProps) {
  const [driver, setDriver] = useState(info.configured_driver)
  const [port, setPort] = useState(info.configured_port)
  const [normal, setNormal] = useState(String(info.normal_p))
  const [limp, setLimp] = useState(String(info.limp_p))
  const [busy, setBusy] = useState(false)
  const { act } = useFeedback()
  const form = useRef<HTMLFormElement>(null)
  const maxP = driver === 'feetech1910' ? 254 : 16383
  const dirty =
    driver !== info.configured_driver ||
    (!info.port_override && port.trim() !== info.configured_port)
  useEffect(() => {
    onPending?.(busy || dirty)
  }, [onPending, busy, dirty])
  function prepareSave() {
    if (!form.current?.reportValidity()) throw Error('请检查舵机配置的输入值。')
    const fields: Record<string, unknown> = { servo_driver: driver }
    if (!info.port_override && port.trim() !== info.configured_port) fields.port = port.trim()
    if (!wizard) {
      fields.normal_p = Number(normal)
      fields.limp_p = Number(limp)
    }
    return async () => { await robot.request('robot.setHardware', fields) }
  }
  useImperativeHandle(ref, () => ({
    prepareSave,
    refresh,
    isDirty: () => dirty || (!wizard && (Number(normal) !== info.normal_p || Number(limp) !== info.limp_p)),
  }))
  async function save() {
    setBusy(true)
    await act(async () => {
      await prepareSave()()
      await refresh()
    }, '配置已保存。总线是否就绪请查看连接状态。')
    setBusy(false)
  }
  return (
    <Panel
      title="舵机驱动与串口"
      description="同一驱动下，变更端口或运行增益会停止运动并重连。更换驱动时，本次硬件配置一起在重启后生效。运动始终需要另行启用。"
    >
      <form
        ref={form}
        onSubmit={(e) => {
          e.preventDefault()
          if (onSave) onSave()
          else void save()
        }}
      >
        <FieldGroup>
          <div className="grid gap-4 sm:grid-cols-2">
            <Choice
              label="舵机驱动"
              value={driver}
              onChange={setDriver}
              options={[
                ['feetech1910', '飞特 HD1910 / STS'],
                ['xl330', 'Dynamixel XL330'],
              ]}
            />
            <DevicePicker
              label="串口"
              value={info.port_override ? info.effective_port : port}
              onChange={setPort}
              options={info.ports.map((entry) => ({ id: entry.path, label: entry.path, available: entry.accessible }))}
              disabled={info.port_override}
              placeholder="选择或输入串口路径"
              hint={info.port_override ? undefined : '选择检测到的串口，或直接输入设备路径。'}
            />
          </div>
          {info.port_override ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <LockKeyhole size={16} />
              启动参数 --port 已锁定串口，当前使用 {info.effective_port}。
            </p>
          ) : null}
          {!wizard && (
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label="正常 P（policy.gain）"
                hint={'已保存 P · ' + info.normal_p}
                value={normal}
                onChange={(e) => setNormal(e.target.value)}
                type="number"
                min={0}
                max={maxP}
                step={1}
                required
              />
              <TextField
                label="卸力时低增益 P（safety.gain_limp）"
                hint={
                  '已保存 P · ' +
                  info.limp_p +
                  '。用于摔倒等低增益状态。完全关闭扭矩请使用「全部卸力」。'
                }
                value={limp}
                onChange={(e) => setLimp(e.target.value)}
                type="number"
                min={0}
                max={maxP}
                step={1}
                required
              />
            </div>
          )}
          {!onSave && <div className="flex flex-wrap items-center gap-2">
            {!onSave && <Button disabled={busy} type="submit">
              保存硬件配置
            </Button>}
            <Button type="button" variant="outline" onClick={() => refresh()}>
              <RefreshCw data-icon="inline-start" />
              刷新状态
            </Button>
          </div>}
        </FieldGroup>
      </form>
      <div className="mt-3 flex flex-col items-start gap-2">
        <Badge variant="secondary">总线 · {busNames[info.bus_status] || info.bus_status}</Badge>
        {info.restart_required && (
          <p className="text-sm">
            驱动切换等待重启，端口和 P 也将在重启后生效。请停止运动后重启 robotd。
          </p>
        )}
        <Problem>{info.bus_error}</Problem>
      </div>
    </Panel>
  )
}
