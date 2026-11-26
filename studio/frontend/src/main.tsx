import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Gamepad2, Library, Sparkles, SlidersHorizontal, Settings2, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Blank, Duck, FeedbackProvider, Heading, Problem, useFeedback } from '@/components/StudioUI'
import { debug, robot, useConnected } from '@/lib/api'
import { useHardware } from '@/lib/session'
import type { DebugState } from '@/lib/model'
import { Control } from '@/pages/Control'
import { Actions } from '@/pages/Actions'
import { Settings } from '@/pages/Settings'
import { DebugPage } from '@/pages/DebugPage'
import { Wizard } from '@/pages/Wizard'
import { cn } from '@/lib/utils'
import './index.css'

const pages = [
  { id: 'control', name: '一起操控', icon: Gamepad2 },
  { id: 'actions', name: '动作库', icon: Library },
  { id: 'auto', name: '自主运行', icon: Sparkles },
  { id: 'debug', name: '硬件调试', icon: SlidersHorizontal },
  { id: 'settings', name: '配置', icon: Settings2 },
]
function Studio() {
  const [hash, setHash] = useState(location.hash.slice(1))
  const ready = useConnected()
  const { info, error, refresh } = useHardware()
  const { act, confirm, notify } = useFeedback()
  const [device, setDevice] = useState({ simulated: false, active: false })
  const [route, section = ''] = hash.split('/')
  const commissioning = info?.calibration_required ?? route === 'commissioning'
  const current = commissioning
    ? 'commissioning'
    : pages.some((p) => p.id === route)
      ? route
      : 'control'
  useEffect(() => {
    const onHash = () => setHash(location.hash.slice(1))
    window.addEventListener('hashchange', onHash)
    const fault = (e: Event) => notify((e as CustomEvent<string>).detail, true)
    robot.addEventListener('fault', fault)
    return () => {
      window.removeEventListener('hashchange', onHash)
      robot.removeEventListener('fault', fault)
    }
  }, [])
  useEffect(() => {
    if (info?.calibration_required) {
      if (location.hash !== '#commissioning') location.hash = 'commissioning'
    }
  }, [info?.calibration_required])
  useEffect(() => {
    let live = true
    const apply = (s: DebugState) => {
      if (live) setDevice({ simulated: s.simulated, active: s.active })
    }
    const update = (e: Event) => apply((e as CustomEvent<DebugState>).detail)
    window.addEventListener('studio-debug-state', update)
    if (ready)
      debug('status')
        .then(apply)
        .catch(() => {})
    else setDevice({ simulated: false, active: false })
    return () => {
      live = false
      window.removeEventListener('studio-debug-state', update)
    }
  }, [ready])
  useEffect(() => {
    document.title =
      (pages.find((p) => p.id === current)?.name || '首次标定') + ' · microduck Studio'
  }, [current])
  async function stop() {
    window.dispatchEvent(new Event('studio-stop'))
    await act(async () => {
      const status = await debug('status').catch(() => null)
      if (status?.active || (!status && device.active)) {
        if (!(await confirm('调试模式下全部卸力？', '请扶稳实物。此操作会关闭全部舵机的保持力。')))
          return
        await debug('torque', { id: null, on: false })
        notify('已请求全部卸力，请检查扭矩回读')
      } else {
        await robot.request('robot.stop')
        notify('已请求停止运动')
      }
    })
  }
  return (
    <div
      className={cn(
        'mx-auto flex min-h-dvh w-full max-w-[1920px] flex-col',
        current === 'control' && 'h-dvh min-h-0 overflow-hidden',
      )}
    >
      <header className="flex shrink-0 items-center gap-2 px-4 pb-3 pt-4 sm:gap-3 sm:px-8">
        <Duck className="size-11" />
        <div className="leading-none">
          <strong className="text-2xl font-bold tracking-tight">microduck</strong>
          <small className="mt-1 block text-[9px] tracking-[.19em] text-muted-foreground">
            A LITTLE COMPANION
          </small>
        </div>
        <div className="ml-auto flex items-center justify-end gap-1 text-xs text-muted-foreground sm:gap-2">
          <i className={cn('size-1.5 rounded-full bg-muted-foreground', ready && 'bg-live')} />
          <span className="max-[430px]:sr-only">
            {ready ? (device.simulated ? '模拟设备 · 已连接' : '已连接运行端') : '运行端未连接'}
          </span>
          <span className="hidden md:inline">{location.host}</span>
        </div>
        <Button variant="destructive" size="sm" onClick={stop}>
          <Square data-icon="inline-start" />
          {device.active ? '调试：全部卸力' : '停止运动'}
        </Button>
      </header>
      <nav
        aria-label="主导航"
        className="flex shrink-0 gap-1 overflow-x-auto px-3 pb-3 sm:gap-2 sm:px-8"
      >
        {pages.map((p) => (
          <Button
            key={p.id}
            variant="ghost"
            disabled={commissioning}
            aria-current={current === p.id ? 'page' : undefined}
            className={cn(
              'rounded-full px-2 text-xs sm:px-4 sm:text-sm',
              p.id === 'settings' && 'ml-auto',
              current === p.id &&
                'bg-foreground text-background hover:bg-foreground hover:text-background',
            )}
            onClick={() => {
              location.hash = p.id
            }}
          >
            <p.icon data-icon="inline-start" />
            {p.name}
          </Button>
        ))}
      </nav>
      <Separator />
      <main
        className={cn(
          'flex min-w-0 flex-1 flex-col gap-4 px-4 py-4 sm:px-8',
          current === 'control' && 'min-h-0',
        )}
      >
        <Problem>{error}</Problem>
        {current === 'commissioning' ? (
          <Wizard
            info={info}
            refresh={refresh}
            done={() => {
              location.hash = 'control'
            }}
          />
        ) : current === 'control' ? (
          info ? (
            <Control
              enabled={info.bus_status === 'ready' && !device.active && !info.calibration_required}
            />
          ) : (
            <Blank title={ready ? '正在读取设备配置' : '等待运行端连接'}>
              连接 robotd 后，将显示操控台或首次标定向导。
            </Blank>
          )
        ) : current === 'actions' ? (
          <Actions />
        ) : current === 'debug' ? (
          <DebugPage initial={section} />
        ) : current === 'settings' ? (
          <Settings section={section} info={info} refresh={refresh} />
        ) : (
          <>
            <Heading section="自主行动" title="下一段旅程，留在这里。" />
            <Blank title="自主行动暂未开放">后续在这里接入任务、环境观察和决策摘要。</Blank>
            <Button
              variant="outline"
              className="mx-auto"
              onClick={() => {
                location.hash = 'control'
              }}
            >
              回到手动操控
            </Button>
          </>
        )}
      </main>
      {current !== 'control' && (
        <footer className="mt-auto flex justify-between px-4 py-4 text-[11px] text-muted-foreground sm:px-8">
          <span>microduck Studio · 本机控制</span>
          <span>设备操作由 robotd 执行</span>
        </footer>
      )}
    </div>
  )
}
robot.connect()
createRoot(document.getElementById('root')!).render(
  <FeedbackProvider>
    <Studio />
  </FeedbackProvider>,
)
