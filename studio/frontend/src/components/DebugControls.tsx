import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Field, FieldGroup, FieldLabel, FieldDescription } from '@/components/ui/field'
import { Slider } from '@/components/ui/slider'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Input } from '@/components/ui/input'
import { Choice, Panel, Problem, TextField, useFeedback } from './StudioUI'
import type { DebugSession } from '@/lib/session'
import type { Joint } from '@/lib/model'
import { labels } from '@/lib/motion'
import { PoseView } from './PoseView'
import { canEditZero, jointLimits, POSITION_MIN_TICKS, POSITION_MAX_TICKS } from '@/lib/calibration'
import { referenceOffsetDegrees } from '@/lib/commissioning'

interface SessionProps {
  session: DebugSession
}
const modes = { off: '卸力', hold: '固定保持', follow: '柔顺跟随' }
export function DebugToolbar({ session }: SessionProps) {
  const { state, busy, run } = session
  const { act, confirm } = useFeedback()
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant="secondary">
        {state?.simulated ? '模拟设备 · ' : ''}
        {state?.active ? '调试模式' : '正常控制'}
      </Badge>
      <Button
        disabled={busy || !state || state.active}
        onClick={() => act(() => run('enter'), '已进入调试并请求卸力，请扶稳实物')}
      >
        进入调试
      </Button>
      <Button
        variant="outline"
        disabled={busy || !state?.active}
        onClick={() => act(() => run('exit'), '已退出调试，运动策略需要另行启用')}
      >
        退出调试
      </Button>
      <Button
        variant="destructive"
        disabled={!state?.active || busy}
        onClick={async () => {
          if (await confirm('全部卸力？', '请先扶稳实物，卸力后关节可能下垂。'))
            await act(() => run('torque', { id: null, on: false }), '已请求全部卸力，请检查回读')
        }}
      >
        全部卸力
      </Button>
    </div>
  )
}

export function Modes({ session }: SessionProps) {
  const { state, busy, run } = session
  const [p, setP] = useState(20)
  const { act } = useFeedback()
  return (
    <FieldGroup>
      <Field>
        <FieldLabel>保持方式</FieldLabel>
        <ToggleGroup
          type="single"
          variant="outline"
          disabled={!state?.active || busy}
          value={state?.mode || 'off'}
          onValueChange={(v) => {
            if (v) void act(() => run('mode', { mode: v, p }))
          }}
        >
          {Object.entries(modes).map(([v, label]) => (
            <ToggleGroupItem key={v} value={v} disabled={v === 'hold' && !state?.settings.every(jointLimits)}>
              {label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </Field>
      <Field>
        <FieldLabel id="hold-gain">
          本次调试 P <output>{p}</output>
        </FieldLabel>
        <Slider
          aria-labelledby="hold-gain"
          value={[p]}
          min={0}
          max={254}
          onValueChange={(v) => setP(v[0])}
        />
        <FieldDescription>选择保持方式时应用。柔顺跟随约移动 0.35° 后响应；输出上限在下方调节，仍需扶稳实物。</FieldDescription>
      </Field>
      <Field>
        <FieldLabel id="follow-output-limit">跟随输出上限 <output>{((state?.follow_output_limit ?? 250) / 10).toFixed(0)}%</output></FieldLabel>
        <FollowOutputSlider session={session} />
        <FieldDescription>驱动输出上限，不是实测力矩。滑动结束后应用，0% 为卸力，不会提高舵机原有上限。</FieldDescription>
      </Field>
      <Button
        variant="outline"
        disabled={!state?.active || busy || state.mode === 'off'}
        onClick={() =>
          act(() => run('mode', { mode: state!.mode, p }), '调试 P 已应用到当前保持方式')
        }
      >
        应用调试 P
      </Button>
    </FieldGroup>
  )
}

function FollowOutputSlider({ session }: SessionProps) {
  const { state, busy, run } = session
  const [draft, setDraft] = useState<number | null>(null)
  const { act } = useFeedback()
  return <div className="flex items-center gap-3">
    <Slider aria-labelledby="follow-output-limit" value={[draft ?? (state?.follow_output_limit ?? 250) / 10]} min={0} max={100} step={1}
      disabled={!state?.active || busy} onValueChange={v => setDraft(v[0])}
      onValueCommit={v => { void (async () => {
        await act(() => run('follow_limit', { limit: Math.round(v[0] * 10) }), '跟随输出上限已应用')
        setDraft(null)
      })() }} />
    <span className="w-12 shrink-0 text-right text-sm tabular-nums">{draft ?? (state?.follow_output_limit ?? 250) / 10}%</span>
  </div>
}

interface TableProps {
  session: DebugSession
  selected?: number
  onSelect?: (i: number) => void
  edit?: boolean
  applied?: (value: boolean, changed?: boolean) => void
}
export function JointTable({ session, selected, onSelect, edit = true, applied }: TableProps) {
  const { state, run, busy } = session
  const { act } = useFeedback()
  const [draft, setDraft] = useState<Record<number, Partial<Joint>>>({})
  if (!state) return null
  const disabled = !state.active || busy || state.mode !== 'off'
  const set = (id: number, change: Partial<Joint>) => {
    applied?.(false)
    setDraft((prev) => ({ ...prev, [id]: { ...prev[id], ...change } }))
  }
  async function apply() {
    if (!state) return
    const joints = state.settings.map((j) => ({ ...j, ...draft[j.id] }))
    if (
      await act(
        () => run('settings', { joints }),
        '方向与限位已应用到本次会话，保存标准姿态时写入文件',
      )
    ) {
      setDraft({})
      const changed = joints.some((joint, i) => {
        const previous = state.settings[i]
        return (
          joint.direction !== previous.direction ||
          joint.min_ticks !== previous.min_ticks ||
          joint.max_ticks !== previous.max_ticks
        )
      })
      applied?.(true, changed)
    }
  }
  return (
    <Panel
      title="关节读数"
      description={
        '在线 ' +
        state.readings.filter((r) => r.ticks !== null && !r.error).length +
        ' / 15 · ' +
        (session.fresh ? '实时回读' : state.active ? '反馈已过期' : '未采样')
      }
    >
      <Table>
        <TableHeader>
          <TableRow>
            {[
              '关节 / ID',
              '编码器',
              '扭矩',
              'P',
              '输出上限',
              '电压 / 温度',
              '零位',
              '方向', '最小位置', '最大位置',
            ].map((v) => (
              <TableHead key={v}>{v}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {state.settings.map((joint, i) => {
            const j = { ...joint, ...draft[joint.id] }
            const r = state.readings.find((v) => v.id === j.id)
            const angle =
              r?.ticks != null && joint.zero_ticks != null && joint.direction
                ? (((r.ticks - joint.zero_ticks) * joint.direction * 360) / 4096).toFixed(1) + '°'
                : '未标定'
            return (
              <TableRow key={j.id} data-state={selected === i ? 'selected' : undefined}>
                <TableCell title={state.names[i]}>
                  {onSelect ? (
                    <Button variant="ghost" size="sm" onClick={() => onSelect(i)}>
                      {labels[i]} / {j.id}
                    </Button>
                  ) : (
                    labels[i] + ' / ' + j.id
                  )}
                </TableCell>
                <TableCell title={r?.error || undefined}>
                  {r?.error ?? r?.ticks ?? '—'}
                  {state.reference_ticks && <small className="block text-xs text-muted-foreground">
                    {referenceOffsetDegrees(r?.ticks, state.reference_ticks[i], joint.direction) == null
                      ? '已记录零点 · 方向待确认'
                      : referenceOffsetDegrees(r?.ticks, state.reference_ticks[i], joint.direction)!.toFixed(2) + '° · 相对标准姿态'}
                  </small>}
                  {!state.reference_ticks && <small className="block text-xs text-muted-foreground">{angle}</small>}
                </TableCell>
                <TableCell>{r?.torque == null ? '未知' : r.torque ? '已使能' : '已卸力'}</TableCell>
                <TableCell>{r?.p ?? '—'}</TableCell>
                <TableCell>{r?.output_limit == null ? '—' : (r.output_limit / 10).toFixed(1) + '%'}</TableCell>
                <TableCell>
                  {r?.voltage == null ? '—' : r.voltage.toFixed(1) + ' V'} /{' '}
                  {r?.temperature == null ? '—' : r.temperature + '°'}
                </TableCell>
                <TableCell>{j.zero_ticks ?? '—'}</TableCell>
                {edit ? (
                  <>
                    <TableCell>
                      <Choice
                        compact
                        disabled={disabled}
                        label={labels[i] + '方向'}
                        value={String(j.direction ?? 'unset')}
                        options={[
                          ['unset', '未设置'],
                          ['1', '正向'],
                          ['-1', '反向'],
                        ]}
                        onChange={(v) => set(j.id, { direction: v === 'unset' ? null : Number(v) })}
                      />
                    </TableCell>
                    {(['min_ticks', 'max_ticks'] as const).map((key, k) => (
                      <TableCell key={key}>
                        <Input
                          type="number"
                          min={POSITION_MIN_TICKS}
                          max={POSITION_MAX_TICKS}
                          step={1}
                          className="w-22"
                          density="compact"
                          disabled={disabled}
                          aria-label={labels[i] + (k ? '最大位置' : '最小位置')}
                          value={j[key] ?? ''}
                          onChange={(e) =>
                            set(j.id, {
                              [key]: e.target.value === '' ? null : Number(e.target.value),
                            })
                          }
                        />
                      </TableCell>
                    ))}
                  </>
                ) : <>
                  <TableCell>{j.direction === 1 ? '正向' : j.direction === -1 ? '反向' : '未确认'}{state.mirrored?.[i] && <small className="block text-xs text-muted-foreground">镜像推导</small>}</TableCell>
                  {(['min_ticks', 'max_ticks'] as const).map(key => <TableCell key={key}>
                    {j[key] ?? '—'}
                    {state.reference_ticks && <small className="block text-xs text-muted-foreground">{referenceOffsetDegrees(j[key], state.reference_ticks[i], j.direction)?.toFixed(2) ?? '—'}°</small>}
                  </TableCell>)}
                </>}
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
      {edit && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button disabled={disabled} onClick={apply}>
            应用方向与限位
          </Button>
          <small className="text-muted-foreground">
            卸力后可编辑，采集并保存标准姿态时写入设备。
          </small>
        </div>
      )}
    </Panel>
  )
}

interface JointEditorProps {
  session: DebugSession
  index: number
  onIndex: (i: number) => void
}
export function JointZeroControl({ session, index, onIndex }: JointEditorProps) {
  const { state, busy, run } = session
  const j = state!.settings[index]
  const [zero, setZero] = useState<string | null>(null)
  const { act, confirm } = useFeedback()
  const zeroDisabled = busy || !canEditZero(state!, j)
  async function saveZero() {
    const value = Number(zero ?? j.zero_ticks)
    if (
      await confirm(
        '保存 ' + labels[index] + ' 的软件零位？',
        '仅更新此关节的编码器零位并备份原文件。需要回归时另行点击「回归零位」。',
      )
    )
      if (await act(() => run('set_zero', { id: j.id, ticks: value }), '该关节软件零位已保存'))
        setZero(null)
  }
  return (
    <>
      <Choice
        label="选中关节"
        value={String(index)}
        onChange={(v) => onIndex(Number(v))}
        options={state!.settings.map((j, i) => [String(i), labels[i] + ' / ID ' + j.id])}
      />
      <TextField
        label="软件零位（编码器计数）"
        disabled={zeroDisabled}
        type="number"
        min={POSITION_MIN_TICKS}
        max={POSITION_MAX_TICKS}
        value={zero ?? j.zero_ticks ?? ''}
        onChange={(e) => setZero(e.target.value)}
        hint="先采集并保存标准姿态，再卸力逐颗微调。"
      />
      <Button
        variant="outline"
        disabled={
          zeroDisabled ||
          zero === null ||
          zero === '' ||
          !Number.isInteger(Number(zero)) ||
          Number(zero) < POSITION_MIN_TICKS ||
          Number(zero) > POSITION_MAX_TICKS
        }
        onClick={saveZero}
      >
        保存该关节零位
      </Button>
    </>
  )
}

export function JointEditor({ session, index, onIndex }: JointEditorProps) {
  const { state, busy, run } = session
  const j = state!.settings[index]
  const reading = state!.readings.find((v) => v.id === j.id)
  const [ticks, setTicks] = useState(String(reading?.ticks ?? j.zero_ticks ?? ''))
  const [p, setP] = useState(String(reading?.p ?? ''))
  const { act } = useFeedback()
  const disabled = busy || !state!.active
  const min = j.min_ticks ?? POSITION_MIN_TICKS,
    max = j.max_ticks ?? POSITION_MAX_TICKS
  const validTicks =
    ticks !== '' && Number.isInteger(Number(ticks)) && Number(ticks) >= min && Number(ticks) <= max
  return (
    <Panel title="单关节控制" description="调整输入值后，点击对应按钮才会发送请求。">
      <FieldGroup>
        <JointZeroControl session={session} index={index} onIndex={onIndex} />
        <TextField
          label="目标编码器位置"
          type="number"
          min={min}
          max={max}
          value={ticks}
          onChange={(e) => setTicks(e.target.value)}
        />
        {max > min && (
          <Slider
            aria-label="目标编码器位置"
            min={min}
            max={max}
            value={[validTicks ? Number(ticks) : min]}
            onValueChange={(v) => setTicks(String(v[0]))}
          />
        )}
        <Button
          disabled={disabled || j.min_ticks == null || j.max_ticks == null || !validTicks}
          onClick={() =>
            act(
              () => run('position', { id: j.id, ticks: Number(ticks) }),
              '位置目标已接受，请观察关节回读',
            )
          }
        >
          移动到目标
        </Button>
        <TextField
          label="关节 P"
          type="number"
          min={0}
          max={254}
          value={p}
          onChange={(e) => setP(e.target.value)}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={
              disabled ||
              p === '' ||
              !Number.isInteger(Number(p)) ||
              Number(p) < 0 ||
              Number(p) > 254
            }
            onClick={() => act(() => run('gain', { id: j.id, p: Number(p) }))}
          >
            设置关节 P
          </Button>
          <Button
            variant="outline"
            disabled={disabled}
            onClick={() => act(() => run('torque', { id: j.id, on: false }))}
          >
            单颗卸力
          </Button>
        </div>
      </FieldGroup>
    </Panel>
  )
}

export function CalibrationPose({ session, saved }: SessionProps & { saved?: () => void }) {
  const { state, busy, run } = session
  const { act, confirm } = useFeedback()
  return (
    <div className="grid gap-4 lg:grid-cols-[1.15fr_1fr]">
      <div className="flex min-h-72">
        <PoseView angles={state?.reference} label="标准零位姿态 · 固定参照" />
      </div>
      <Panel
        title="对照标准姿态，手动摆正"
        description="按需启用柔顺跟随。全部关节稳定至少 1 秒后，一键采集并保存零位；回归零位需先启用保持或柔顺跟随。"
      >
        <FieldGroup>
          <Modes session={session} />
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={!state?.active || busy}
              onClick={async () => {
                if (await confirm('将当前姿态设为零位？', '请确认实物已摆成标准姿态并保持稳定。将读取全部关节、计算并保存软件零位，原文件会备份。'))
                  if (await act(async () => { await run('capture'); await run('save') }, '舵机零位、方向与限位已保存')) saved?.()
              }}
            >
              将当前姿态设为零位
            </Button>
            {state?.candidate && <Button
              variant="outline"
              disabled={!state?.active || busy}
              onClick={async () => {
                if (
                  await confirm(
                    '保存标准姿态与零位？',
                    '将根据采集结果计算软件零位，并备份原标定文件。',
                  )
                )
                  if (await act(() => run('save'), '舵机零位、方向与限位已保存')) saved?.()
              }}
            >
              重试保存已采集零位
            </Button>}
            <Button
              variant="outline"
              disabled={!state?.active || busy || state.mode === "off" || state.settings.some((j) => j.zero_ticks == null)}
              onClick={async () => {
                if (
                  await confirm(
                    '回归零位？',
                    '请扶稳实物并确认关节运动空间，全部关节将缓慢回归标准姿态。',
                  )
                )
                  await act(() => run('home'), '归位请求已接受，请查看实际回读')
              }}
            >
              回归零位
            </Button>
          </div>
          {state?.saved && (
            <p className="break-all text-xs text-muted-foreground">已保存至 {state.saved}</p>
          )}
        </FieldGroup>
      </Panel>
    </div>
  )
}
export function ImuCalibration({ session, saved }: SessionProps & { saved?: () => void }) {
  const { state, busy, run } = session
  const [mount, setMount] = useState<string | null>(null)
  const { act, confirm } = useFeedback()
  return (
    <Panel
      title="身体 IMU · 单独标定"
      description="让小鸭直立在桌面上，保持静止至少 2 秒。静态校准只能修正倾斜，安装前向需由你确认。"
    >
      <FieldGroup>
        <p className="text-sm">
          {state?.imu_error ||
            (state?.imu
              ? '身体 IMU 在线 · gyro ' +
                state.imu.gyro.map((v) => v.toFixed(3)).join(' / ') +
                ' rad/s'
              : '等待身体 IMU 数据')}
        </p>
        <TextField
          label="已确认的安装四元数 [w,x,y,z]"
          value={mount ?? (state?.imu_mount ? JSON.stringify(state.imu_mount) : '')}
          onChange={(e) => setMount(e.target.value)}
          placeholder="填写已确认的安装方向"
        />
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={!state?.active || busy}
            onClick={() =>
              act(async () => {
                const raw = mount ?? (state?.imu_mount ? JSON.stringify(state.imu_mount) : '')
                if (!raw.trim()) throw Error('请输入已确认的安装四元数')
                const q = JSON.parse(raw)
                if (!Array.isArray(q) || q.length !== 4 || !q.every(Number.isFinite))
                  throw Error('安装四元数须包含四个有限数')
                await run('imu_capture', { mount: q })
              }, '身体 IMU 已采集，等待独立保存')
            }
          >
            采集身体 IMU
          </Button>
          <Button
            variant="outline"
            disabled={!state?.active || busy || !state.imu_candidate}
            onClick={async () => {
              if (
                await confirm(
                  '独立保存身体 IMU 标定？',
                  '只写入身体 IMU 的安装校正值，并保留舵机零位。',
                )
              )
                if (await act(() => run('imu_save'), '身体 IMU 标定已保存')) {
                  setMount(null)
                  saved?.()
                }
            }}
          >
            保存身体 IMU
          </Button>
        </div>
      </FieldGroup>
    </Panel>
  )
}
export function DebugNotices({ session }: SessionProps) {
  return (
    <>
      <Problem>{session.error}</Problem>
      <Problem>{session.state?.error}</Problem>
    </>
  )
}
