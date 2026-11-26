import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Skeleton } from '@/components/ui/skeleton'
import { Heading, Panel, useFeedback } from '@/components/StudioUI'
import {
  CalibrationPose,
  DebugNotices,
  DebugToolbar,
  ImuCalibration,
  JointEditor,
  JointTable,
  Modes,
} from '@/components/DebugControls'
import { PoseView } from '@/components/PoseView'
import { debugPose } from '@/lib/calibration'
import { useDebug } from '@/lib/session'

export function DebugPage({
  settingsOnly = false,
  initial = 'debug',
}: {
  settingsOnly?: boolean
  initial?: string
}) {
  const session = useDebug()
  const { state, run, busy } = session
  const [selected, setSelected] = useState(0)
  const [page, setPage] = useState(initial === 'calibration' ? 'calibration' : 'debug')
  const { act } = useFeedback()
  const pose = state ? debugPose(state, session.fresh) : null
  const scan = (
    <Button
      variant="outline"
      disabled={!state?.active || busy}
      onClick={() => act(() => run('scan'), '舵机回读已刷新')}
    >
      检查全部关节
    </Button>
  )
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {!settingsOnly && (
        <>
          <Heading
            section="硬件调试 / HD1910"
            title={page === 'debug' ? '让每个关节，就位。' : '把现在，定义为零位。'}
          >
            {page === 'debug'
              ? '回读关节，调整保持力度，逐一检查运动。'
              : '对照固定姿态摆正实物，保存属于这只鸭子的零位。'}
          </Heading>
          <Tabs value={page} onValueChange={setPage}>
            <TabsList>
              <TabsTrigger value="debug">舵机调试</TabsTrigger>
              <TabsTrigger value="calibration">零位 / IMU 标定</TabsTrigger>
            </TabsList>
          </Tabs>
        </>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <DebugToolbar session={session} />
        {scan}
      </div>
      <DebugNotices session={session} />
      {!state && !session.error && <Skeleton className="h-36 w-full" />}
      {state && (
        <>
          {!settingsOnly &&
            (page === 'calibration' ? (
              <>
                <CalibrationPose session={session} />
                <ImuCalibration session={session} />
              </>
            ) : (
              <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
                <div className="flex min-h-80">
                  <PoseView angles={pose?.angles} label={pose?.label || '等待读数'} />
                </div>
                <Panel
                  title="保持控制"
                  description={
                    '当前模式 · ' +
                    { off: '卸力', hold: '固定保持', follow: '柔顺跟随' }[state.mode]
                  }
                >
                  <Modes session={session} />
                </Panel>
              </div>
            ))}
          {!settingsOnly && state.settings[selected] && (
            <JointEditor
              key={
                state.settings[selected].id +
                '/' +
                (state.readings.some((r) => r.id === state.settings[selected].id && r.ticks != null)
                  ? 'sample'
                  : 'waiting')
              }
              session={session}
              index={selected}
              onIndex={setSelected}
            />
          )}
          <JointTable
            session={session}
            selected={settingsOnly ? undefined : selected}
            onSelect={settingsOnly ? undefined : setSelected}
          />
        </>
      )}
    </div>
  )
}
