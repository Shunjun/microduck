import { useEffect, useState } from 'react'
import { LockKeyhole, RefreshCw } from 'lucide-react'
import { FieldGroup } from '@/components/ui/field'
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
}
export function HardwareForm({ info, refresh, wizard = false, onPending }: HardwareFormProps) {
  const [driver, setDriver] = useState(info.configured_driver)
  const [port, setPort] = useState(info.configured_port)
  const [normal, setNormal] = useState(String(info.normal_p))
  const [limp, setLimp] = useState(String(info.limp_p))
  const [busy, setBusy] = useState(false)
  const { act } = useFeedback()
  const maxP = driver === 'feetech1910' ? 254 : 16383
  const dirty =
    driver !== info.configured_driver ||
    (!info.port_override && port.trim() !== info.configured_port)
  useEffect(() => {
    onPending?.(busy || dirty)
  }, [onPending, busy, dirty])
  async function save() {
    setBusy(true)
    await act(async () => {
      const fields: Record<string, unknown> = { servo_driver: driver }
      if (!info.port_override && port.trim() !== info.configured_port) fields.port = port.trim()
      if (!wizard) {
        fields.normal_p = Number(normal)
        fields.limp_p = Number(limp)
      }
      await robot.request('robot.setHardware', fields)
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
        onSubmit={(e) => {
          e.preventDefault()
          void save()
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
            <TextField
              label="串口路径"
              required
              disabled={info.port_override}
              value={info.port_override ? info.configured_port : port}
              onChange={(e) => setPort(e.target.value)}
              placeholder="/dev/ttyUSB0"
            />
          </div>
          {info.port_override ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <LockKeyhole size={16} />
              启动参数 --port 已锁定串口，当前使用 {info.effective_port}。
            </p>
          ) : (
            info.ports.length > 0 && (
              <Choice
                label="检测到的串口"
                value={info.ports.some((p) => p.path === port) ? port : 'manual'}
                onChange={(v) => {
                  if (v !== 'manual') setPort(v)
                }}
                options={[
                  ['manual', '手动输入路径'],
                  ...info.ports.map(
                    (p) =>
                      [p.path, p.path + (p.accessible ? '' : '（不可访问）')] as [string, string],
                  ),
                ]}
              />
            )
          )}
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
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={busy} type="submit">
              保存硬件配置
            </Button>
            <Button type="button" variant="outline" onClick={() => refresh()}>
              <RefreshCw data-icon="inline-start" />
              刷新状态
            </Button>
          </div>
        </FieldGroup>
      </form>
      <dl className="mt-5 grid grid-cols-2 gap-3 text-sm">
        {[
          ['已保存端口', info.configured_port],
          ['实际使用端口', info.effective_port],
          ['已保存驱动', info.configured_driver],
          ['运行中驱动', info.active_driver],
        ].map(([key, v]) => (
          <div key={key}>
            <dt className="text-xs text-muted-foreground">{key}</dt>
            <dd className="break-all font-mono">{v || '未配置'}</dd>
          </div>
        ))}
      </dl>
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
