import { useEffect, useState } from 'react'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { FieldGroup } from '@/components/ui/field'
import { Badge } from '@/components/ui/badge'
import {
  DebugNotices,
  DebugToolbar,
  Modes,
  ImuCalibration,
  JointTable,
} from '@/components/DebugControls'
import { HardwareForm } from '@/components/HardwareForm'
import { Heading, Panel, Problem, TextField, useFeedback } from '@/components/StudioUI'
import {
  canStartServoCheck,
  finishProblems,
  reusablePose,
  reusableImu,
} from '@/lib/calibration'
import { useDebug, type DebugSession } from '@/lib/session'
import type { Hardware } from '@/lib/model'
import { JointGuide, ReferenceCapture } from '@/components/CommissioningSteps'
import { guidedJointsReady, servoResponseCount } from '@/lib/commissioning'

const steps = ['串口验证', '标准零点', '方向与限位', '身体 IMU', '检查并完成']

function UnitSettings({ session }: { session: DebugSession }) {
  const { state, busy, run } = session
  const [speed, setSpeed] = useState<string | null>(null)
  const [current, setCurrent] = useState<string | null>(null)
  const { act } = useFeedback()
  const speedValue = speed ?? String(state?.speed_rad_s_per_unit ?? '')
  const currentValue = current ?? String(state?.current_ma_per_unit ?? '')
  return (
    <Panel
      title="确认设备换算单位"
      description="使用该舵机型号已核实的单位。两项均需为正数，缺少任一项将无法完成标定。"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void act(async () => {
            const s = Number(speedValue),
              c = Number(currentValue)
            if (!Number.isFinite(s) || !Number.isFinite(c) || s <= 0 || c <= 0)
              throw Error('请输入两个已确认的正数')
            await run('units', { speed_rad_s_per_unit: s, current_ma_per_unit: c })
            setSpeed(null)
            setCurrent(null)
          }, '速度和电流单位已保存')
        }}
      >
        <FieldGroup>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="速度（rad/s 每原始单位）"
              type="number"
              step="any"
              value={speedValue}
              onChange={(e) => setSpeed(e.target.value)}
              required
            />
            <TextField
              label="电流（mA 每原始单位）"
              type="number"
              step="any"
              value={currentValue}
              onChange={(e) => setCurrent(e.target.value)}
              required
            />
          </div>
          <Button className="self-start" disabled={!state?.active || busy}>
            保存换算单位
          </Button>
        </FieldGroup>
      </form>
    </Panel>
  )
}
interface WizardProps {
  info: Hardware | null
  refresh: () => Promise<void>
  done: () => void
}
export function Wizard({ info, refresh, done }: WizardProps) {
  const session = useDebug()
  const { state, run, busy } = session
  const { act, confirm, notify } = useFeedback()
  const [step, setStep] = useState(0)
  const [hardwarePending, setHardwarePending] = useState(false)
  const [verifiedAt, setVerifiedAt] = useState(0)
  const [imuSaved, setImuSaved] = useState(false)
  const [finishing, setFinishing] = useState(false)
  const [finishError, setFinishError] = useState('')
  useEffect(() => { setVerifiedAt(0); setStep(0) }, [info?.effective_port, info?.active_driver])
  const count = servoResponseCount(state)
  const verified = verifiedAt > 0 && count > 0 && (session.fresh || Date.now() - verifiedAt < 30000)
  const serialReady = canStartServoCheck(info) && !hardwarePending
  const problems = state ? finishProblems(state) : ['等待读取标定状态。']
  const allowed = [serialReady && verified, !!state?.reference_ticks,
    guidedJointsReady(state) && !!state && reusablePose(state), imuSaved && !!state && reusableImu(state)]
  async function next() {
    if (step === 0) {
      setStep(1)
      await act(async () => {
        if (!state?.active) await run('enter')
        await run('mode', { mode: 'follow', p: state?.p ?? 20 })
      }, '已进入柔顺跟随，请扶稳实物并摆成标准姿态')
    } else setStep(i => i + 1)
  }
  async function finish() {
    if (!(await confirm('完成设备标定？', 'robotd 将卸力并重新打开总线。进入操控页后，请另行启用运动。'))) return
    setFinishing(true); setFinishError('')
    try { await run('finish'); await refresh(); done(); notify('标定已完成，运动需要另行启用') }
    catch (cause) { setFinishError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setFinishing(false) }
  }
  return <div className="flex min-w-0 flex-col gap-5">
    <Heading section="首次装机 / 标定向导" title="先让小鸭认识自己的身体。">先验证串口并保存标准零点，再逐关节确认方向和安全行程。</Heading>
    <ol aria-label="标定步骤" className="flex flex-wrap gap-2">{steps.map((name, i) => <li key={name} aria-current={i === step ? 'step' : undefined}>
      <Badge variant={i === step ? 'default' : 'outline'}>{i + 1} · {name}</Badge>
    </li>)}</ol>
    {step > 0 && <DebugToolbar session={session} />}
    <DebugNotices session={session} />
    {step === 0 && <>
      {info ? <HardwareForm key={info.configured_driver + info.configured_port} info={info} refresh={refresh} wizard servoVerified={verified} onPending={setHardwarePending} /> : <p>等待读取串口配置…</p>}
      <Panel title="验证串口连接" description="探测当前串口，读到至少一颗有效舵机即可继续；不依赖普通控制或策略的就绪状态。">
        <FieldGroup>
          <Button disabled={!serialReady || busy} onClick={async () => {
            setVerifiedAt(0)
            await act(async () => {
              const result = await run('probe')
              if (!servoResponseCount(result)) throw Error('此串口没有读到有效舵机，请检查驱动、串口、波特率和供电')
              setVerifiedAt(Date.now())
            }, '串口已验证，可以进入标准零点设置')
          }}>验证串口上的舵机</Button>
          <p className="text-sm">{verified ? `已验证舵机响应 · ${count} / 15 在线` : '请先验证所选串口上的舵机。'}</p>
          {verified && count < 15 && <small className="text-muted-foreground">串口已确认；下一步完整摆姿采集仍需要全部 15 颗舵机在线。</small>}
        </FieldGroup>
      </Panel>
      {!!state?.readings.length && <JointTable session={session} edit={false} />}
    </>}
    {(step === 1 || step === 2) && <Panel title="摆姿保持方式" description="默认柔顺跟随，可随时卸力。输出上限与 P 独立设置。"><Modes session={session} /></Panel>}
    {step === 1 && <ReferenceCapture session={session} />}
    {step === 2 && <>
      <JointGuide session={session} />
      <p className="text-sm text-muted-foreground">已保存 {state?.joint_calibrated.filter(Boolean).length ?? 0} / 15 个关节（包括镜像项）。</p>
      <JointTable session={session} edit={false} />
    </>}
    {step === 3 && <>
      <ImuCalibration session={session} saved={() => setImuSaved(true)} />
      {!imuSaved && state && reusableImu(state) && <Button variant="outline" className="self-start" onClick={() => setImuSaved(true)}>沿用已保存的身体 IMU 标定</Button>}
    </>}
    {step === 4 && <>
      <UnitSettings session={session} />
      <Panel title="完成前检查" description="验证保存的完整标定，卸力后重新打开普通控制。">
        {problems.length ? <ul className="list-disc pl-5 text-sm">{problems.map(p => <li key={p}>{p}</li>)}</ul> : <p className="text-sm">标定数据已填写，等待 robotd 最终验证。</p>}
        <Problem>{finishError || state?.calibration_error || info?.calibration_error}</Problem>
      </Panel>
    </>}
    <div className="flex items-center justify-between gap-3">
      <Button variant="outline" disabled={step === 0 || busy || finishing} onClick={() => setStep(i => i - 1)}><ArrowLeft data-icon="inline-start" />上一步</Button>
      {step < 4 ? <Button disabled={!allowed[step] || busy || (step > 0 && !state?.active)} onClick={next}>下一步<ArrowRight data-icon="inline-end" /></Button>
        : <Button disabled={busy || finishing || !serialReady || !state?.active || problems.length > 0} onClick={finish}>完成标定</Button>}
    </div>
  </div>
}
