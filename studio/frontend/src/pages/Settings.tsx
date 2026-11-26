import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { FieldGroup } from '@/components/ui/field'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Choice, Heading, Panel, Problem, TextField, useFeedback } from '@/components/StudioUI'
import { HardwareForm } from '@/components/HardwareForm'
import { http, message, robot, useConnected } from '@/lib/api'
import type { Entry, Hardware, Policy } from '@/lib/model'
import { preferences } from '@/lib/motion'
import { mediaUrl } from '@/lib/media.js'
import { DebugPage } from './DebugPage'

function MediaSettings() {
  const [url, setUrl] = useState(mediaUrl)
  const { act } = useFeedback()
  return (
    <Panel
      title="摄像头连接"
      description="通过 mediad 的 WebRTC 信令连接实时画面。地址仅保存在当前浏览器。"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void act(async () => {
            const address = new URL(url)
            if (!['ws:', 'wss:'].includes(address.protocol))
              throw Error('请使用 ws:// 或 wss:// 信令地址')
            localStorage.setItem('microduck.studio.signalling', address.href)
          }, '摄像头地址已保存，下次连接时生效')
        }}
      >
        <FieldGroup>
          <TextField
            label="本机媒体信令地址"
            required
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <Button className="self-start">保存连接地址</Button>
        </FieldGroup>
      </form>
    </Panel>
  )
}

function ControlSettings() {
  const [prefs] = useState(preferences)
  const { act } = useFeedback()
  return (
    <Panel title="当前浏览器的操控偏好" description="默认速度在下次进入操控页时生效。">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          const values = new FormData(e.currentTarget)
          void act(
            async () =>
              localStorage.setItem(
                'microduck.studio.preferences',
                JSON.stringify(Object.fromEntries([...values].map(([k, v]) => [k, Number(v)]))),
              ),
            '操控偏好已保存',
          )
        }}
      >
        <FieldGroup>
          <TextField
            label="默认速度上限（%）"
            name="speed"
            type="number"
            defaultValue={prefs.speed}
            min={0}
            max={100}
            step={0.1}
            required
          />
          <TextField
            label="满幅前进 / 后退速度（m/s）"
            name="forward"
            type="number"
            defaultValue={prefs.forward}
            min={0.01}
            max={0.5}
            step={0.01}
            required
          />
          <TextField
            label="满幅转向速度（rad/s）"
            name="turn"
            type="number"
            defaultValue={prefs.turn}
            min={0.05}
            max={2}
            step={0.05}
            required
          />
          <Button className="self-start">保存操控偏好</Button>
        </FieldGroup>
      </form>
    </Panel>
  )
}

function Binding({
  policy,
  entries,
  refresh,
}: {
  policy: Policy
  entries: Entry[]
  refresh: () => void
}) {
  const [path, setPath] = useState(policy.path || 'default')
  const { act, confirm } = useFeedback()
  const models = entries.filter(
    (e) => e.manifest.kind === 'perpetual' && e.manifest.slot === policy.slot,
  )
  async function bind() {
    if (
      await confirm(
        '更新 ' + policy.slot + ' 策略绑定？',
        '请先停止运动并扶稳实物。绑定可能触发重新就位。',
      )
    )
      if (
        await act(
          () =>
            robot.request('robot.loadPolicy', {
              slot: policy.slot,
              path: path === 'default' ? null : path,
            }),
          '策略绑定请求已完成',
        )
      )
        refresh()
  }
  return (
    <Panel title={policy.slot} description={policy.path || '运行端默认'}>
      <Problem>{policy.error}</Problem>
      {['walk', 'stand'].includes(policy.slot) ? (
        <FieldGroup>
          <Choice
            label={policy.slot + ' 策略'}
            value={path}
            onChange={setPath}
            options={[
              ['default', '恢复运行端默认'],
              ...(policy.path && !models.some((e) => e.path === policy.path)
                ? [[policy.path, '当前已加载的模型'] as [string, string]]
                : []),
              ...models.map((e) => [e.path, e.manifest.name] as [string, string]),
            ]}
          />
          <Button className="self-start" variant="outline" onClick={bind}>
            应用绑定
          </Button>
        </FieldGroup>
      ) : (
        <p>该槽位只读</p>
      )}
    </Panel>
  )
}
function Policies() {
  const ready = useConnected()
  const [data, setData] = useState<{ slots: Policy[]; entries: Entry[] } | null>(null)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let live = true
    setError('')
    setData(null)
    if (ready)
      Promise.all([
        robot.request<{ slots: Policy[] }>('robot.policies'),
        http<{ entries: Entry[] }>('/api/actions'),
      ])
        .then(([p, l]) => {
          if (live) setData({ slots: p.slots, entries: l.entries })
        })
        .catch((e) => {
          if (live) setError(message(e))
        })
    return () => {
      live = false
    }
  }, [ready, revision])
  return (
    <div className="grid gap-3">
      <Problem>{error}</Problem>
      {!data && !error && <p>等待运行端策略绑定…</p>}
      {data?.slots.map((p) => (
        <Binding
          key={p.slot + p.path}
          policy={p}
          entries={data.entries}
          refresh={() => setRevision((v) => v + 1)}
        />
      ))}
    </div>
  )
}
const sections = {
  hardware: '硬件',
  control: '操控偏好',
  media: '摄像头',
  policies: '策略绑定',
  joints: '关节配置',
}
interface SettingsProps {
  section: string
  info: Hardware | null
  refresh: () => Promise<void>
}
export function Settings({ section, info, refresh }: SettingsProps) {
  const current = section in sections ? section : 'hardware'
  return (
    <div className="flex flex-col gap-5">
      <Heading section="设备 / 配置" title="照顾这只小鸭。">
        管理运行端配置与当前浏览器的操控偏好。
      </Heading>
      <Tabs
        value={current}
        onValueChange={(v) => {
          location.hash = 'settings/' + v
        }}
      >
        <TabsList className="h-auto flex-wrap">
          {Object.entries(sections).map(([k, v]) => (
            <TabsTrigger value={k} key={k}>
              {v}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value={current} className={current === 'joints' ? '' : 'max-w-3xl'}>
          {current === 'hardware' ? (
            info ? (
              <HardwareForm
                key={[
                  info.configured_driver,
                  info.configured_port,
                  info.normal_p,
                  info.limp_p,
                ].join('|')}
                info={info}
                refresh={refresh}
              />
            ) : (
              <p>等待硬件配置…</p>
            )
          ) : current === 'control' ? (
            <ControlSettings />
          ) : current === 'media' ? (
            <MediaSettings />
          ) : current === 'policies' ? (
            <Policies />
          ) : (
            <DebugPage settingsOnly />
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
