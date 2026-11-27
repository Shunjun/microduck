import { useEffect, useRef, useState } from 'react'
import { Camera, ScanLine, X, ArrowUpRight } from 'lucide-react'
import { connectMedia } from '@/lib/media.js'
import { message, robot, useConnected } from '@/lib/api'
import { quickSkillNames } from '@/lib/skills'
import { preferences, unitQuaternion } from '@/lib/motion'
import type { Frame, Skills, Policies } from '@/lib/model'
import { Joystick } from '@/components/Joystick'
import { PoseView } from '@/components/PoseView'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Slider } from '@/components/ui/slider'
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
    setSkillsError('')
    if (ready)
      Promise.all([robot.request<Skills>('robot.skills'), robot.request<Policies>('robot.policies')])
        .then(([data, policies]) => {
          if (live) setSkills(quickSkillNames(data, policies).slice(0, 3))
        })
        .catch((e) => {
          if (live) setSkillsError(message(e))
        })
    return () => {
      live = false
    }
  }, [ready])
  const fresh = robot.fresh()
  const frame = robot.frame
  const measured = fresh && frame?.joints?.length === 15 && frame.joints.every(Number.isFinite)
  if (measured) last.current = frame
  const health = robot.health
  const quickActions = fresh && (health?.healthy || health?.degraded) ? skills : []
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
    window.dispatchEvent(new Event('studio-stop'))
    if (await confirm(title, details))
      await act(() => robot.request(method, params), '请求已接受，请观察实物反馈')
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
        <header className="hidden md:block">
          <h1 className="text-xl font-semibold tracking-tight">带小鸭走一走</h1>
          <p className="text-xs text-muted-foreground">拖动摇杆移动，松开回中停止</p>
        </header>
        <div className="row-span-3 md:my-1">
          <Joystick speed={speed} prefs={prefs} enabled={enabled} />
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
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!ready || !enabled}
            onClick={() =>
              command('站立就位？', '请确认小鸭有支撑，周围有足够空间。', 'robot.init')
            }
          >
            站立就位
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!ready || !enabled}
            onClick={() =>
              command('启用运动策略？', '启用后摇杆可驱动小鸭行走。', 'robot.enable', { on: true })
            }
          >
            启用策略
          </Button>
        </div>
        <Separator className="hidden md:block" />
        <div>
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">熟悉的小动作</h2>
            <Button asChild variant="link" size="sm">
              <a href="#actions">全部 →</a>
            </Button>
          </div>
          <div className="flex flex-wrap gap-1">
            {quickActions?.map((name) => (
              <Button
                key={name}
                size="sm"
                variant="secondary"
                disabled={!enabled}
                onClick={() =>
                  command('执行「' + name + '」？', '实物会运行此动作，请留出空间。', 'robot.do', {
                    skill: name,
                  })
                }
              >
                {name}
              </Button>
            ))}
            {!quickActions?.length && (
              <small className="text-muted-foreground">
                {skillsError || (skills ? '暂无可用动作' : '等待动作列表')}
              </small>
            )}
          </div>
        </div>
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
