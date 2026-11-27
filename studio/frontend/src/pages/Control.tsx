import { useEffect, useRef, useState } from 'react'
import { Camera, ScanLine, X, ArrowUpRight } from 'lucide-react'
import { connectMedia } from '@/lib/media.js'
import { http, message, robot, useConnected } from '@/lib/api'
import { quickSkillNames } from '@/lib/skills'
import { policySlots, trialSkill } from '@/lib/policy-slots'
import { actionName } from '@/lib/action-name'
import { preferences, unitQuaternion } from '@/lib/motion'
import type { Entry, Frame, Skills, Policies } from '@/lib/model'
import { Joystick } from '@/components/Joystick'
import { PoseView } from '@/components/PoseView'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Blank, Duck, useFeedback } from '@/components/StudioUI'

function CameraView() {
  const video = useRef<HTMLVideoElement>(null)
  const stop = useRef<() => void>(() => {})
  const [status, setStatus] = useState('尚未连接摄像头')
  useEffect(() => () => stop.current(), [])
  function connect() {
    stop.current()
    try {
      stop.current = connectMedia(video.current, setStatus)
    } catch (cause) {
      setStatus(message(cause))
    }
  }
  return (
    <div className="relative min-h-0 flex-1 overflow-hidden rounded-3xl bg-stage">
      <video
        ref={video}
        autoPlay
        playsInline
        muted
        controls
        className="absolute inset-0 size-full object-contain"
        aria-label="摄像头实时画面"
      />
      {status !== '摄像头已连接' && (
        <div className="absolute inset-0 grid place-content-center bg-stage p-4 text-center">
          <Blank title={status}>请检查本设备的摄像头与视频服务是否就绪。</Blank>
          <Button className="mx-auto" onClick={connect}>
            <Camera data-icon="inline-start" />
            连接 / 重试
          </Button>
        </div>
      )}
    </div>
  )
}

export function Control({ enabled }: { enabled: boolean }) {
  const ready = useConnected()
  const { confirm, act } = useFeedback()
  const [prefs] = useState(preferences)
  const [speed, setSpeed] = useState(prefs.speed)
  const [view, setView] = useState('pose')
  const [dismissed, setDismissed] = useState(
    () => sessionStorage.getItem('microduck.companion.dismissed') === '1',
  )
  const [, redraw] = useState(0)
  const [skills, setSkills] = useState<string[] | null>(null)
  const [registered, setRegistered] = useState<Skills['skills']>([])
  const [favorites, setFavorites] = useState<Entry[]>([])
  const [favoriteError, setFavoriteError] = useState('')
  const [policies, setPolicies] = useState<Policies | null>(null)
  const [commandBusy, setCommandBusy] = useState(false)
  const [skillsError, setSkillsError] = useState('')
  const last = useRef<Frame | null>(null)
  const lastOrientation = useRef<number[] | undefined>(undefined)
  useEffect(() => {
    const draw = () => redraw((n) => n + 1)
    robot.addEventListener('frame', draw)
    robot.addEventListener('health', draw)
    const clock = setInterval(draw, 500)
    return () => {
      clearInterval(clock)
      robot.removeEventListener('frame', draw)
      robot.removeEventListener('health', draw)
    }
  }, [])
  useEffect(() => {
    let live = true
    setSkills(null)
    setRegistered([])
    setPolicies(null)
    setSkillsError('')
    const load = () => {
      Promise.all([robot.request<Skills>('robot.skills'), robot.request<Policies>('robot.policies')])
        .then(([data, policies]) => {
          if (live) {
            setSkills(quickSkillNames(data, policies))
            setRegistered(data.skills)
            setPolicies(policies)
            setSkillsError('')
          }
        })
        .catch((e) => {
          if (live) setSkillsError(message(e))
        })
    }
    if (ready) load()
    const timer = ready ? setInterval(load, 2000) : undefined
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [ready])
  useEffect(() => {
    let live = true
    const load = () => http<{ entries: Entry[] }>('/api/actions').then((result) => {
      if (live) {
        setFavorites(result.entries.filter((entry) => entry.favorite && entry.manifest.kind === 'episodic'))
        setFavoriteError('')
      }
    }).catch((error) => { if (live) setFavoriteError(message(error)) })
    void load()
    const timer = setInterval(load, 5000)
    return () => { live = false; clearInterval(timer) }
  }, [])
  const fresh = robot.fresh()
  const frame = robot.frame
  const measured = fresh && frame?.joints?.length === 15 && frame.joints.every(Number.isFinite)
  if (measured) last.current = frame
  const health = robot.health
  //Compatible: older robotd does not report live control intent; never guess from configured models.
  const controlKnown = typeof policies?.control_enabled === 'boolean'
  const controlOn = policies?.control_enabled === true
  const actionReady = !!(enabled && controlOn && fresh && policies?.enabled && !skillsError && (health?.healthy || health?.degraded))
  const imuOk =
    health?.imu?.ready && !health.imu.missing && health.imu.consecutive_stale_blocks < 25
  if (measured) lastOrientation.current = imuOk ? unitQuaternion(frame.imu?.quat) : undefined
  const source = fresh && !frame?.move?.limited_by?.includes('deadman') ? frame?.move?.source : null
  const body = !fresh
    ? '未知'
    : !imuOk
      ? 'IMU 未就绪 / 异常'
      : frame?.safety?.fallen
        ? '已摔倒'
        : frame?.safety?.picked_up
          ? '被抱起'
          : frame?.safety?.limp
            ? '低增益保持'
            : '未报告异常'
  async function command(title: string, details: string, method: string, params = {}) {
    if (commandBusy) return
    setCommandBusy(true)
    window.dispatchEvent(new Event('studio-stop'))
    try {
      if (await confirm(title, details))
        await act(() => robot.request(method, params), '请求已接受，请观察实物反馈')
    } finally { setCommandBusy(false) }
  }
  async function setControl(on: boolean) {
    if (commandBusy) return
    setCommandBusy(true)
    window.dispatchEvent(new Event('studio-stop'))
    await act(async () => {
      if (on) await robot.request('robot.enable', { on: true })
      else await robot.request('robot.relax')
      setPolicies(await robot.request<Policies>('robot.policies'))
    }, on ? '已启动控制' : '已请求卸力，请扶稳小鸭')
    setCommandBusy(false)
  }
  return (
    <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_auto] gap-2 md:grid-rows-1 md:grid-cols-[minmax(0,1fr)_15rem] md:gap-5 xl:grid-cols-[minmax(0,1fr)_17rem] xl:gap-7">
      <Tabs value={view} onValueChange={setView} className="flex min-h-0 min-w-0 flex-col gap-2">
        <TabsContent value="pose" className="flex min-h-0 flex-1">
          <PoseView
            angles={last.current?.joints}
            orientation={lastOrientation.current}
            label={
              measured
                ? '实测关节姿态'
                : last.current
                  ? '反馈过期 · 保留最后姿态'
                  : '等待反馈 · 模型初始姿态'
            }
          >
            {!dismissed && (
              <div className="absolute inset-x-4 bottom-16 flex max-w-sm items-center gap-3 rounded-2xl border bg-background/95 p-3 shadow-sm backdrop-blur">
                <Duck className="size-12 shrink-0" />
                <div>
                  <strong className="text-sm">我在这里，等你一起出发。</strong>
                  <p className="text-xs text-muted-foreground">
                    {fresh ? '当前策略 · ' + frame?.policy : '等待设备连接'}
                  </p>
                  <Button variant="link" size="xs" className="px-0" asChild>
                    <a href="#actions">
                      给小鸭一个动作
                      <ArrowUpRight data-icon="inline-end" />
                    </a>
                  </Button>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="ml-auto self-start"
                  aria-label="关闭伙伴提示"
                  onClick={() => {
                    setDismissed(true)
                    sessionStorage.setItem('microduck.companion.dismissed', '1')
                  }}
                >
                  <X />
                </Button>
              </div>
            )}
          </PoseView>
        </TabsContent>
        <TabsContent value="camera" className="flex min-h-0 flex-1">
          <CameraView />
        </TabsContent>
        <div className="flex items-center justify-between gap-2">
          <TabsList>
            <TabsTrigger value="pose">
              <ScanLine />
              3D 姿态
            </TabsTrigger>
            <TabsTrigger value="camera">
              <Camera />
              摄像头画面
            </TabsTrigger>
          </TabsList>
          <small className="hidden text-muted-foreground sm:block">实测反馈 · 非动作预测</small>
        </div>
      </Tabs>
      <aside className="grid min-w-0 grid-cols-[minmax(112px,.8fr)_minmax(0,1.2fr)] items-center gap-x-3 gap-y-1.5 rounded-2xl border p-2 md:flex md:min-h-0 md:flex-col md:items-stretch md:gap-3 md:overflow-y-auto md:rounded-none md:border-0 md:p-0 md:pr-1">
        <header className="col-span-2">
          <div className="flex items-center justify-between gap-2">
            <h1 className="text-xl font-semibold tracking-tight">带小鸭走一走</h1>
            <Switch aria-label="启动控制，关闭时卸力" checked={controlOn} disabled={!ready || commandBusy || !controlKnown || (!controlOn && (!enabled || !fresh || !policies?.enabled))} onCheckedChange={(on) => void setControl(on)} />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{!controlKnown ? '等待控制状态；旧版 robotd 需要更新。' : controlOn ? '控制已开启 · 松开摇杆停止移动' : '控制已关闭 · 关闭开关会卸力，请扶稳小鸭'}</p>
        </header>
        <div className="row-span-3 md:my-1">
          <Joystick speed={speed} prefs={prefs} enabled={enabled && controlOn && !commandBusy} />
        </div>
        <div className="flex flex-col gap-2">
          <label className="flex justify-between text-sm font-medium" id="speed-label">
            本次速度上限 <output>{speed.toFixed(1)}%</output>
          </label>
          <Slider
            value={[speed]}
            onValueChange={(v) => setSpeed(v[0])}
            min={0}
            max={100}
            step={0.1}
            aria-labelledby="speed-label"
          />
          <small className="hidden text-muted-foreground md:block">
            临时调节，默认值在配置中设置
          </small>
        </div>
        <section className="col-span-2" aria-label="固定动作">
          <div className="flex flex-wrap gap-2">
          {policySlots.slice(2).map(([slot, name, description]) => {
            const skill = trialSkill(slot)!
            const policy = policies?.slots.find((entry) => entry.slot === slot)
            const loaded = !!policy?.path && !policy.error && !!skills?.includes(skill)
            const label = slot === 'sitstand' ? policies?.sitting === true ? '起立' : policies?.sitting === false ? '坐下' : '坐下 / 起立' : name
            return (
              <Button key={slot} size="sm" variant="outline" disabled={!actionReady || !loaded || commandBusy} title={!loaded ? '尚未加载可用模型' : description} onClick={() => command('执行「' + label + '」？', slot === 'sitstand' ? '将切换坐下 / 起立姿态，请扶稳小鸭并留出空间。' : '实物会运行此动作，请留出空间。', 'robot.do', { skill })}>{label}</Button>
            )
          })}
          </div>
          {!actionReady && <p className="text-[11px] text-muted-foreground">{skillsError || '设备与运动策略就绪后可执行动作。'}</p>}
        </section>
        <Separator className="col-span-2" />
        <section className="col-span-2" aria-label="自定义动作">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">自定义动作</h2>
            <Button asChild variant="link" size="sm"><a href="#actions">动作库 →</a></Button>
          </div>
          <div className="flex flex-wrap gap-2">
            {favorites.map((entry) => {
              const available = registered.some((skill) => skill.name === entry.manifest.name && skill.path === entry.path) && skills?.includes(entry.manifest.name)
              return <Button key={entry.id} size="sm" variant="secondary" disabled={!actionReady || !available || commandBusy || !!favoriteError} title={!available ? "请先在动作库注册这个模型" : entry.manifest.description} onClick={() => command("执行「" + actionName(entry) + "」？", "实物会运行收藏的动作，请留出空间。", "robot.do", { skill: entry.manifest.name })}>{actionName(entry)}</Button>
            })}
            {!favorites.length && <p className="text-xs text-muted-foreground">{favoriteError || "在动作库收藏动作后，会显示在这里。"}</p>}
          </div>
        </section>
        <Separator className="col-span-2" />
        <dl className="col-span-2 grid grid-cols-4 gap-x-2 gap-y-1 md:grid-cols-2 md:gap-3">
          {[
            ['电量估算', health?.battery ? Math.round(health.battery.percent) + '%' : '—'],
            ['连接往返', ready ? Math.round(robot.latency) + ' ms' : '—'],
            ['运行策略', fresh ? frame?.policy : '—'],
            ['身体状态', body],
          ].map(([key, val]) => (
            <div
              key={key}
              title={
                key === '电量估算' && health?.battery
                  ? health.battery.volts.toFixed(2) + ' V，根据 2S 电池电压估算'
                  : undefined
              }
            >
              <dt className="text-xs text-muted-foreground">{key}</dt>
              <dd className="text-sm font-medium">{val}</dd>
            </div>
          ))}
        </dl>
        <Badge className="col-span-2" variant="outline">
          {source === 'studio'
            ? '当前由你控制'
            : source
              ? '控制来源 · ' + source
              : '尚无实时控制来源'}
        </Badge>
      </aside>
    </div>
  )
}
