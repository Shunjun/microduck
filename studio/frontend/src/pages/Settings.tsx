import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { FieldGroup } from '@/components/ui/field'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Heading, Panel, TextField, useFeedback } from '@/components/StudioUI'
import { HardwareSettings } from '@/components/HardwareSettings'
import type { Hardware } from '@/lib/model'
import { preferences } from '@/lib/motion'
import { DebugPage } from './DebugPage'

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

const sections = {
  hardware: '硬件',
  control: '操控偏好',
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
              <HardwareSettings info={info} refresh={refresh} />
            ) : (
              <p>等待硬件配置…</p>
            )
          ) : current === 'control' ? (
            <ControlSettings />
          ) : (
            <DebugPage settingsOnly />
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
