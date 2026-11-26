import { useEffect, useState } from 'react'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { FieldGroup } from '@/components/ui/field'
import { Badge } from '@/components/ui/badge'
import {
  CalibrationPose,
  DebugNotices,
  DebugToolbar,
  ImuCalibration,
  JointTable,
  JointZeroControl,
} from '@/components/DebugControls'
import { HardwareForm } from '@/components/HardwareForm'
import { Heading, Panel, Problem, TextField, useFeedback } from '@/components/StudioUI'
import {
  canStartServoCheck,
  finishProblems,
  jointLimits,
  reusablePose,
  reusableImu,
} from '@/lib/calibration'
import { useDebug, type DebugSession } from '@/lib/session'
import type { Hardware } from '@/lib/model'

const steps = ['连接硬件', '读取舵机', '方向与限位', '标准姿态', '身体 IMU', '检查并完成']

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
  const [scanned, setScanned] = useState(false)
  const [limitsApplied, setLimitsApplied] = useState(false)
  const [limitsChanged, setLimitsChanged] = useState(false)
  const [poseSaved, setPoseSaved] = useState(false)
  const [selected, setSelected] = useState(0)
  const [imuSaved, setImuSaved] = useState(false)
  const [finishing, setFinishing] = useState(false)
  const [finishError, setFinishError] = useState('')
  const ready = info?.bus_status === 'ready' && !info.restart_required
  useEffect(() => {
    setScanned(false)
    setLimitsChanged(false)
    setLimitsApplied(false)
    setPoseSaved(false)
    setImuSaved(false)
    setStep(0)
  }, [info?.effective_port, info?.active_driver])
  const count = state?.readings.filter((r) => r.ticks != null && !r.error).length || 0
  const problems = state ? finishProblems(state) : ['等待读取标定状态。']
  const allowed = [
    canStartServoCheck(info) && !hardwarePending,
    scanned && session.fresh && count === 15,
    limitsApplied && state?.settings.length === 15 && state.settings.every(jointLimits),
    poseSaved && !!state && reusablePose(state),
    imuSaved && !!state && reusableImu(state),
  ]
  async function finish() {
    if (
      !(await confirm(
        '完成设备标定？',
        'robotd 将卸力并重新打开总线。进入操控页后，请另行确认站立与启用策略。',
      ))
    )
      return
    setFinishing(true)
    setFinishError('')
    try {
      await run('finish')
      await refresh()
      done()
      notify('标定已完成。站立与启用策略需要另行操作。')
    } catch (cause) {
      setFinishError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setFinishing(false)
    }
  }
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <Heading section="首次装机 / 标定向导" title="先让小鸭认识自己的身体。">
        请按顺序检查硬件，完成舵机零位与身体 IMU 标定。
      </Heading>
      <ol aria-label="标定步骤" className="flex flex-wrap gap-2">
        {steps.map((name, i) => (
          <li key={name} aria-current={i === step ? 'step' : undefined}>
            <Badge variant={i === step ? 'default' : 'outline'}>
              {i + 1} · {name}
            </Badge>
          </li>
        ))}
      </ol>
      {step !== 0 && <DebugToolbar session={session} />}
      <DebugNotices session={session} />
      {step === 0 &&
        (info ? (
          <HardwareForm
            key={info.configured_driver + info.configured_port}
            info={info}
            refresh={refresh}
            wizard
            onPending={setHardwarePending}
          />
        ) : (
          <p>等待读取硬件配置…</p>
        ))}
      {step === 1 && (
        <>
          <Panel
            title="读取全部 15 颗舵机"
            description="先扶稳实物，点击进入调试，再扫描总线。请检查离线 ID 和逐颗回读。"
          >
            <Button
              disabled={!state?.active || busy}
              onClick={async () => {
                setScanned(false)
                if (await act(() => run('scan'), '扫描完成，请核对关节回读')) setScanned(true)
              }}
            >
              扫描舵机
            </Button>
          </Panel>
          <JointTable session={session} edit={false} />
        </>
      )}
      {step === 2 && (
        <JointTable
          session={session}
          applied={(v, changed) => {
            if (changed) setLimitsChanged(true)
            setLimitsApplied(v)
            setPoseSaved(false)
          }}
        />
      )}
      {step === 3 && (
        <>
          <CalibrationPose
            session={session}
            saved={() => {
              setPoseSaved(true)
              setLimitsChanged(false)
            }}
          />
          {!limitsChanged && !poseSaved && state && reusablePose(state) && (
            <Button variant="outline" className="self-start" onClick={() => setPoseSaved(true)}>
              沿用当前 15 个关节的零位，完成时核验
            </Button>
          )}
          {poseSaved && state && reusablePose(state) && (
            <Panel
              title="单关节零位微调"
              description="请先扶稳实物并选择卸力。每次只保存选中关节的软件零位，回归零位需另行点击。"
            >
              <FieldGroup>
                <JointZeroControl
                  key={state.settings[selected].id}
                  session={session}
                  index={selected}
                  onIndex={setSelected}
                />
              </FieldGroup>
            </Panel>
          )}
        </>
      )}
      {step === 4 && (
        <>
          <ImuCalibration session={session} saved={() => setImuSaved(true)} />
          {!imuSaved && state && reusableImu(state) && (
            <Button variant="outline" className="self-start" onClick={() => setImuSaved(true)}>
              沿用已保存的身体 IMU 标定
            </Button>
          )}
        </>
      )}
      {step === 5 && (
        <>
          <UnitSettings session={session} />
          <Panel title="完成前检查" description="验证保存的完整标定，安全卸力后重新打开普通控制。">
            {problems.length ? (
              <ul className="list-disc pl-5 text-sm">
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            ) : (
              <p className="text-sm">关节、身体 IMU 和物理单位已填写，等待 robotd 最终验证。</p>
            )}
            <Problem>{finishError || state?.calibration_error || info?.calibration_error}</Problem>
          </Panel>
        </>
      )}
      <div className="flex items-center justify-between gap-3">
        <Button
          variant="outline"
          disabled={step === 0 || busy || finishing}
          onClick={() => setStep((i) => i - 1)}
        >
          <ArrowLeft data-icon="inline-start" />
          上一步
        </Button>
        {step < 5 ? (
          <Button
            disabled={!allowed[step] || busy || (step > 0 && !state?.active)}
            onClick={() => setStep((i) => i + 1)}
          >
            下一步
            <ArrowRight data-icon="inline-end" />
          </Button>
        ) : (
          <Button
            disabled={busy || finishing || !ready || !state?.active || problems.length > 0}
            onClick={finish}
          >
            完成标定
          </Button>
        )}
      </div>
    </div>
  )
}
