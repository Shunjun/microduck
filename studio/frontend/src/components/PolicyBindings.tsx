import { useEffect, useRef, useState } from 'react'
import { robot, useConnected } from '@/lib/api'
import type { Entry, Policies, Policy } from '@/lib/model'
import { modelsForSlot, policySlots, trialSkill } from '@/lib/policy-slots'
import { preferences } from '@/lib/motion'
import { Joystick } from './Joystick'
import { Choice, Panel, Problem, useFeedback } from './StudioUI'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'

interface PolicyBindingsProps {
  entries: Entry[]
  policies: Policies | null
  refresh: () => void
}

interface PolicyRowProps {
  policy: Policy
  entries: Entry[]
  enabled: boolean
  refresh: () => void
  trial: (slot: string) => void
}

function PolicyRow({ policy, entries, enabled, refresh, trial }: PolicyRowProps) {
  const [busy, setBusy] = useState(false)
  const ready = useConnected()
  const { act, confirm } = useFeedback()
  const definition = policySlots.find(([slot]) => slot === policy.slot)
  const models = modelsForSlot(entries, policy.slot)
  const current = models.find((model) => model.path === policy.path)
  const value = current?.path ?? (policy.path && policy.overridden ? 'current' : 'default')
  async function bind(path: string) {
    if (path === 'current' || path === value) return
    if (!(await confirm('更换「' + (definition?.[1] ?? policy.slot) + '」模型？', '请先停止运动并扶稳实物。绑定会保存到设备，可能触发重新就位。'))) return
    setBusy(true)
    await act(async () => {
      window.dispatchEvent(new Event('studio-stop'))
      await robot.request('robot.stop')
      await robot.request('robot.loadPolicy', { slot: policy.slot, path: path === 'default' ? null : path })
      for (let attempt = 0; attempt < 40; attempt++) {
        const report = await robot.request<Policies>('robot.policies')
        const loaded = report.slots.find((entry) => entry.slot === policy.slot)
        if (loaded?.error) throw Error('模型加载失败，请查看设备日志。')
        if (loaded && (path === 'default' ? !loaded.overridden : loaded.path === path)) {
          refresh()
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      throw Error('绑定已提交，但尚未确认加载完成。请刷新后检查。')
    }, '策略模型已更新。')
    refresh()
    setBusy(false)
  }
  return (
    <div className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-medium">{definition?.[1] ?? policy.slot}</h3>
        <p className="text-xs text-muted-foreground">{definition?.[2]}</p>
        <Problem>{policy.error ? '模型加载异常，请检查设备日志。' : undefined}</Problem>
      </div>
      <div className="flex items-center gap-2 sm:w-[24rem]">
        <div className="min-w-0 flex-1">
          <Choice label={(definition?.[1] ?? policy.slot) + '使用的模型'} compact value={value} disabled={busy || !ready} onChange={(path) => void bind(path)} options={[
            ['default', '使用项目默认模型'],
            ...(value === 'current' ? [['current', '当前设备模型'] as [string, string]] : []),
            ...models.map((model) => [model.path, model.manifest.name] as [string, string]),
          ]} />
        </div>
        <Button size="sm" variant="outline" disabled={busy || !enabled || !ready || !policy.path || !!policy.error} onClick={() => trial(policy.slot)}>试运行</Button>
      </div>
    </div>
  )
}

interface TrialProps {
  slot: string
  close: () => void
}

function PolicyTrial({ slot, close }: TrialProps) {
  const owned = useRef(false)
  const epoch = useRef(0)
  const [active, setActive] = useState(false)
  const [busy, setBusy] = useState(false)
  const [prefs] = useState(preferences)
  const { act } = useFeedback()
  const name = policySlots.find(([key]) => key === slot)?.[1] ?? slot
  useEffect(() => {
    const stop = () => {
      ++epoch.current
      setActive(false)
      if (!owned.current) return
      owned.current = false
      robot.notify('robot.stop', {})
      robot.notify('robot.enable', { on: false })
    }
    window.addEventListener('blur', stop)
    window.addEventListener('studio-stop', stop)
    window.addEventListener('pagehide', stop)
    document.addEventListener('visibilitychange', stop)
    robot.addEventListener('connection', stop)
    const timer = setInterval(() => { if (owned.current && !robot.fresh()) stop() }, 250)
    return () => {
      stop()
      clearInterval(timer)
      window.removeEventListener('blur', stop)
      window.removeEventListener('studio-stop', stop)
      window.removeEventListener('pagehide', stop)
      document.removeEventListener('visibilitychange', stop)
      robot.removeEventListener('connection', stop)
    }
  }, [])
  async function start() {
    setBusy(true)
    const token = ++epoch.current
    const check = () => {
      if (epoch.current !== token || !owned.current || document.visibilityState !== 'visible') {
        robot.notify('robot.stop', {})
        robot.notify('robot.enable', { on: false })
        throw Error('试运行已取消。')
      }
    }
    const ok = await act(async () => {
      if (!robot.fresh() || !(robot.health?.healthy || robot.health?.degraded)) throw Error('设备反馈未就绪，无法试运行。')
      owned.current = true
      await robot.request('robot.enable', { on: true })
      check()
      const skill = trialSkill(slot)
      if (skill) await robot.request('robot.do', { skill })
      else await robot.request('robot.move', { vx: 0, vy: 0, vyaw: 0 })
      check()
    })
    if (!ok && owned.current) {
      owned.current = false
      robot.notify('robot.stop', {})
      robot.notify('robot.enable', { on: false })
    }
    setActive(ok)
    setBusy(false)
  }
  async function stop() {
    setActive(false)
    window.dispatchEvent(new Event('studio-stop'))
    await act(async () => {
      await robot.request('robot.stop')
      await robot.request('robot.enable', { on: false })
    })
  }
  return (
    <Dialog open onOpenChange={(open) => { if (!open) close() }}>
      <DialogContent>
        <DialogHeader><DialogTitle>试运行 · {name}</DialogTitle><DialogDescription>将驱动实物，请扶稳小鸭并留出运动空间。停止、关闭窗口或切出页面会关闭本次策略运行，不会自动卸力。</DialogDescription></DialogHeader>
        {slot === 'walk' ? <><p className="text-sm text-muted-foreground">启用后，用摇杆小幅试走。松手停止移动，速度上限为默认设置的 20%。</p><Joystick prefs={prefs} speed={Math.min(prefs.speed, 20)} enabled={active && !busy} /></> : <p className="text-sm text-muted-foreground">{slot === 'sitstand' ? '每次运行切换一次坐下 / 起立；停止不会自动恢复原姿态。' : slot === 'stand' ? '运行站立平衡策略，保持零移动指令。' : '按下开始后执行一次当前绑定的动作。'}</p>}
        <div className="flex gap-2"><Button disabled={busy || (active && ['walk', 'stand'].includes(slot))} onClick={() => void start()}>{active ? '再次运行' : '开始试运行'}</Button><Button variant="outline" onClick={() => void stop()}>停止</Button></div>
      </DialogContent>
    </Dialog>
  )
}

export function PolicyBindings({ entries, policies, refresh }: PolicyBindingsProps) {
  const [trial, setTrial] = useState<string | null>(null)
  return (
    <Panel title="策略" description="选择每种行为使用的模型。更换后会保存绑定；试运行会实际驱动小鸭。">
      {policies ? <div className="divide-y">{policies.slots.map((policy) => <PolicyRow key={policy.slot} policy={policy} entries={entries} enabled={policies.enabled} refresh={refresh} trial={setTrial} />)}</div> : <p className="text-sm text-muted-foreground">等待读取设备策略…</p>}
      {policies && !policies.enabled && <p className="text-sm text-muted-foreground">设备未启用策略运行，暂时不能试运行。</p>}
      {trial && <PolicyTrial slot={trial} close={() => setTrial(null)} />}
    </Panel>
  )
}
