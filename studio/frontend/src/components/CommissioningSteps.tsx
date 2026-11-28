import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { FieldGroup } from '@/components/ui/field'
import { Choice, Panel, Problem, useFeedback } from './StudioUI'
import { PoseView } from './PoseView'
import { labels } from '@/lib/motion'
import { demoDegrees, demoPose, observedDirection, referenceOffsetDegrees } from '@/lib/commissioning'
import type { DebugSession } from '@/lib/session'

interface StepProps { session: DebugSession }
export function ReferenceCapture({ session }: StepProps) {
  const { state, busy, run, fresh } = session
  const { act, confirm } = useFeedback()
  return <div className="grid gap-4 lg:grid-cols-[1.15fr_1fr]">
    <div className="flex min-h-96"><PoseView angles={state?.reference} label="标准姿态 · 请照此摆放实物" /></div>
    <Panel title="先保存标准零点" description="扶稳鸭子，按模型摆正并保持静止至少一秒。方向和限位将在下一步设置，无需提前填写。">
      <FieldGroup>
        <p className="text-sm text-muted-foreground">此处先保存每颗舵机的标准姿态原始位置；确认关节方向后，系统会自动计算供运动模型使用的软件零位。</p>
        <Button disabled={!state?.active || busy || !fresh || state.readings.filter(r => r.ticks != null && !r.error).length !== 15}
          onClick={async () => {
            if (await confirm('保存当前标准零点？', '请确认实物与模型姿态一致且已经静止。重新采集会清除本次方向和限位标定，原文件会备份。'))
              await act(() => run('reference_capture'), '标准零点已保存，可以逐关节确认方向与限位')
          }}>保存当前姿态为零点</Button>
        {state?.reference_ticks && <Badge variant="secondary">15 个标准位置已保存到设备</Badge>}
        <small className="text-muted-foreground">尚未确认方向与限位时，只允许跟随手动摆姿，不开放目标位置和归位运动。</small>
      </FieldGroup>
    </Panel>
  </div>
}

type Stage = 'positive' | 'negative' | 'limits'
interface Measurements { positive?: number; negative?: number; first?: number; second?: number }
export function JointGuide({ session }: StepProps) {
  const { state, busy, fresh, run } = session
  const { act } = useFeedback()
  const [index, setIndex] = useState(0)
  const [stage, setStage] = useState<Stage>('positive')
  const [measurements, setMeasurements] = useState<Record<number, Measurements>>({})
  const [fraction, setFraction] = useState(0)
  const referenceKey = state?.reference_ticks?.join(',') ?? ''
  useEffect(() => { setMeasurements({}); setStage('positive') }, [referenceKey])
  useEffect(() => {
    setStage('positive')
    setFraction(0)
  }, [index])
  useEffect(() => {
    let frame = 0
    const start = performance.now()
    function animate(now: number) {
      // Demonstrate only in the browser. Pause near the extreme before returning.
      const wave = (1 - Math.cos(((now - start) % 3200) / 3200 * Math.PI * 2)) / 2
      setFraction(stage === 'positive' ? wave : stage === 'negative' ? -wave : 0)
      frame = requestAnimationFrame(animate)
    }
    if (stage !== 'limits') frame = requestAnimationFrame(animate)
    else setFraction(0)
    return () => cancelAnimationFrame(frame)
  }, [index, stage])
  if (!state?.reference_ticks) return <Panel title="请先保存标准零点"><p>返回上一步，先采集完整的标准姿态。</p></Panel>
  const joint = state.settings[index]
  const reading = state.readings.find(r => r.id === joint.id)
  const points = measurements[joint.id] ?? {}
  const reference = state.reference_ticks[index]
  const sign = observedDirection(reference, points.positive, points.negative, index)
  const offset = referenceOffsetDegrees(reading?.ticks, reference, sign ?? joint.direction)
  const disabled = busy || !state.active || !fresh || reading?.ticks == null || !!reading.error
  const update = (point: Partial<Measurements>) => setMeasurements(old => ({ ...old, [joint.id]: { ...old[joint.id], ...point } }))
  const endpoints = points.first != null && points.second != null ? [Math.min(points.first, points.second), Math.max(points.first, points.second)] : null
  const validEndpoints = !!endpoints && endpoints[0] < endpoints[1] && [reference, points.positive, points.negative].every(v => v != null && v >= endpoints[0] && v <= endpoints[1])
  const direction = sign ?? joint.direction
  const directionText = direction === 1 ? '正向' : direction === -1 ? '反向' : '待采集'
  return <div className="grid gap-4 lg:grid-cols-[1.15fr_1fr]">
    <div className="flex min-h-[420px] flex-col gap-2">
      <PoseView angles={demoPose(state.reference, index, fraction)} selectedJoint={index}
        label={`${labels[index]} · ${stage === 'positive' ? '正向演示' : stage === 'negative' ? '反向演示' : '标准姿态参照'}`} />
      <small className="text-center text-xs text-muted-foreground">模型偏转 {fraction >= 0 ? '+' : ''}{(fraction * demoDegrees(index)).toFixed(1)}° · 仅网页演示，不驱动实物</small>
    </div>
    <Panel title="逐关节确认" description="左腿配置会自动映射到右腿。头部与嘴部逐个记录；右腿也可单独选择校正。">
      <FieldGroup>
        <Choice label="当前关节" value={String(index)} onChange={v => setIndex(Number(v))}
          options={labels.map((name, i) => [String(i), `${name} / ID ${state.settings[i].id}${state.joint_calibrated[i] ? ' · 已保存' : ''}${state.mirrored[i] ? '（镜像）' : ''}`])} />
        <div className="rounded-xl border p-3">
          <p className="text-sm">当前位置 <span className="font-mono tabular-nums">{reading?.ticks ?? '—'}</span></p>
          <small className="block text-xs text-muted-foreground">{offset == null ? '方向待确认；请先观察模型正、反向演示' : `${offset >= 0 ? '+' : ''}${offset.toFixed(2)}° · 相对标准零点`}</small>
          <small className="block text-xs text-muted-foreground">方向：{directionText}</small>
        </div>
        <div className="flex gap-2">
          <Button variant={stage === 'positive' ? 'default' : 'outline'} size="sm" onClick={() => setStage('positive')}>1 · 正向</Button>
          <Button variant={stage === 'negative' ? 'default' : 'outline'} size="sm" disabled={points.positive == null} onClick={() => setStage('negative')}>2 · 反向</Button>
          <Button variant={stage === 'limits' ? 'default' : 'outline'} size="sm" disabled={sign == null} onClick={() => setStage('limits')}>3 · 限位</Button>
        </div>
        {stage !== 'limits' ? <>
          <p className="text-sm">{stage === 'positive' ? '把此关节从标准姿态沿模型演示方向轻转' : '先摆回标准姿态，再沿相反的模型演示方向轻转'}约 {demoDegrees(index)}°，保持位置后记录。观察方向随视角变化，以模型动作一致为准。</p>
          <Button disabled={disabled} onClick={() => {
            if (reading?.ticks == null) return
            if (stage === 'positive') {
              const degrees = Math.abs(reading.ticks - reference) * 360 / 4096
              if (degrees < demoDegrees(index) * .4 || degrees > demoDegrees(index) * 2) {
                void act(async () => { throw Error(`请从标准姿态转动约 ${demoDegrees(index)}° 后记录，当前约 ${degrees.toFixed(1)}°`) })
                return
              }
              update({ positive: reading.ticks, negative: undefined, first: undefined, second: undefined })
              setStage('negative')
            } else {
              const result = observedDirection(reference, points.positive, reading.ticks, index)
              if (!result) { void act(async () => { throw Error('两次转动需位于标准姿态两侧，且角度与模型演示相近') }); return }
              update({ negative: reading.ticks }); setStage('limits')
            }
          }}>{stage === 'positive' ? '记录正向位置' : '记录反向位置'}</Button>
          <small className="text-muted-foreground">正向样本：{points.positive ?? '未记录'} · 反向样本：{points.negative ?? '未记录'}</small>
        </> : <>
          <p className="text-sm">分别摆到两端的安全位置并记录。不要强行顶住机械止挡。</p>
          <div className="grid grid-cols-2 gap-3">
            {(['first', 'second'] as const).map((key, i) => <div key={key} className="flex flex-col gap-1">
              <Button variant="outline" disabled={disabled} onClick={() => update({ [key]: reading!.ticks! })}>记录第 {i + 1} 个限位</Button>
              <small className="text-xs text-muted-foreground">{points[key] ?? '未记录'}{points[key] != null && <span className="block">{referenceOffsetDegrees(points[key], reference, sign)?.toFixed(2)}°</span>}</small>
            </div>)}
          </div>
          {endpoints && !validEndpoints && <Problem>两端限位必须包含标准位置及正、反向样本，并且不能相同。</Problem>}
          <Button disabled={disabled || sign == null || !validEndpoints} onClick={async () => {
            if (sign == null || !endpoints) return
            if (await act(() => run('joint_calibration', { id: joint.id, positive_ticks: points.positive,
              negative_ticks: points.negative, min_ticks: endpoints[0], max_ticks: endpoints[1], mirror: index < 5 }),
              index < 5 ? '关节已保存，并生成对称右腿配置' : '关节方向与限位已保存')) {
              setStage('positive')
              if (index < 9) setIndex(index + 1)
            }
          }}>保存本关节{index < 5 ? '并映射右腿' : ''}</Button>
        </>}
        {index < 5 && <small className="text-xs text-muted-foreground">镜像假设左右舵机型号及安装轴方向一致，使用右腿自身标准位置生成角度范围。右腿镜像项可单独重新标定。</small>}
        {state.mirrored[index] && <Badge variant="secondary">由左腿镜像生成 · 尚非独立方向实测</Badge>}
        <Problem>{reading?.error}</Problem>
      </FieldGroup>
    </Panel>
  </div>
}
