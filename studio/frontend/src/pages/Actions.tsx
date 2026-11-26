import { skillEntries } from '@/lib/skills'
import { useEffect, useRef, useState } from 'react'
import { Plus, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  Blank,
  Choice,
  Duck,
  Heading,
  Panel,
  Problem,
  TextField,
  useFeedback,
} from '@/components/StudioUI'
import { http, message, robot, useConnected } from '@/lib/api'
import type { Entry, Manifest, Skills, Policies } from '@/lib/model'

function parse(source: string): Partial<Manifest> {
  const value = JSON.parse(source)
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw Error('manifest 必须是 JSON 对象')
  return value
}
interface EditorProps {
  entry: Entry | null
  close: () => void
  saved: () => void
}
function Editor({ entry, close, saved }: EditorProps) {
  const initial = entry?.manifest || { kind: 'episodic' }
  const [raw, setRaw] = useState(JSON.stringify(initial, null, 2))
  const [model, setModel] = useState<File | null>(null)
  const [imported, setImported] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [working, setWorking] = useState(false)
  const [durationText, setDurationText] = useState<string | null>(null)
  const readNumber = useRef(0)
  const locked = useRef(false)
  let data: Partial<Manifest> | null
  try {
    data = parse(raw)
  } catch {
    data = null
  }
  function patch(fields: Partial<Manifest>) {
    if (data) setRaw(JSON.stringify({ ...data, ...fields }, null, 2))
  }
  async function load(file?: File) {
    const id = ++readNumber.current
    setImported(false)
    setError('')
    setLoading(!!file)
    if (!file) return
    try {
      if (file.size > 65536) throw Error('manifest 不能超过 64 KiB')
      const manifest = parse(await file.text())
      if (id === readNumber.current) {
        setRaw(JSON.stringify(manifest, null, 2))
        setImported(true)
        setDurationText(null)
      }
    } catch (cause) {
      if (id === readNumber.current) setError(message(cause))
    } finally {
      if (id === readNumber.current) setLoading(false)
    }
  }
  async function submit() {
    if (locked.current) return
    locked.current = true
    setWorking(true)
    setError('')
    try {
      const metadata = new TextEncoder().encode(JSON.stringify(parse(raw)))
      if (metadata.length > 65536) throw Error('manifest 不能超过 64 KiB')
      if (entry)
        await http('/api/actions/' + encodeURIComponent(entry.id) + '/manifest', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: metadata,
        })
      else {
        if (
          !imported ||
          !model ||
          !model.name.toLowerCase().endsWith('.onnx') ||
          model.size <= 0 ||
          model.size > 32 * 1048576
        )
          throw Error('请同时选择非空且不超过 32 MiB 的 ONNX 和有效 manifest 文件')
        const header = new ArrayBuffer(4)
        new DataView(header).setUint32(0, metadata.length)
        await http('/api/actions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: new Blob([header, metadata, model]),
        })
      }
      saved()
    } catch (cause) {
      setError(message(cause))
    } finally {
      locked.current = false
      setWorking(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v && !working) close()
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{entry ? '编辑模型说明' : '导入动作'}</DialogTitle>
          <DialogDescription>
            {entry
              ? '修改说明后，需重新注册或绑定才会更新运行端配置。'
              : '同时选择模型与配套 manifest。保存只写入本机动作库。'}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <FieldGroup>
            {!entry && (
              <div className="grid gap-3 sm:grid-cols-2">
                <TextField
                  label="ONNX 模型（最多 32 MiB）"
                  type="file"
                  accept=".onnx"
                  required
                  onChange={(e) => setModel(e.target.files?.[0] || null)}
                />
                <TextField
                  label="manifest.json"
                  type="file"
                  accept=".json,application/json"
                  required
                  onChange={(e) => load(e.target.files?.[0])}
                />
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                label="动作标识"
                value={data?.name || ''}
                disabled={!data}
                required
                pattern="[A-Za-z0-9_\-]{1,64}"
                onChange={(e) => patch({ name: e.target.value })}
              />
              <TextField
                label="描述"
                value={data?.description || ''}
                disabled={!data}
                onChange={(e) => patch({ description: e.target.value })}
              />
            </div>
            <Choice
              label="类型"
              value={data?.kind || 'episodic'}
              disabled={!data}
              options={[
                ['episodic', '单次动作'],
                ['perpetual', '持续策略'],
              ]}
              onChange={(kind) =>
                patch({
                  kind,
                  duration_s: kind === 'perpetual' ? null : data?.duration_s,
                  slot: kind === 'episodic' ? undefined : data?.slot,
                })
              }
            />
            {data?.kind === 'episodic' ? (
              <TextField
                label="持续时间（秒）"
                type="number"
                step="any"
                min={0.01}
                max={600}
                required
                value={durationText ?? data.duration_s ?? ''}
                onChange={(e) => {
                  setDurationText(e.target.value)
                  patch({ duration_s: e.target.value === '' ? null : Number(e.target.value) })
                }}
              />
            ) : (
              <Choice
                label="持续策略槽位"
                disabled={!data}
                value={data?.slot || 'none'}
                options={[
                  ['none', '不指定'],
                  ['walk', 'walk / 行走'],
                  ['stand', 'stand / 站立'],
                ]}
                onChange={(v) => patch({ slot: v === 'none' ? undefined : v })}
              />
            )}
            <Field>
              <FieldLabel htmlFor="manifest-json">完整 manifest JSON</FieldLabel>
              <Textarea
                id="manifest-json"
                className="min-h-36 font-mono text-xs"
                spellCheck={false}
                value={raw}
                onChange={(e) => {
                  setRaw(e.target.value)
                  setDurationText(null)
                }}
                aria-invalid={!data}
              />
            </Field>
            <Problem>{error || (!data ? '请检查完整 manifest 的 JSON 格式。' : '')}</Problem>
            <Button
              className="self-start"
              disabled={working || loading || !data || (!entry && !imported)}
            >
              {working ? '正在校验并保存…' : '校验并保存'}
            </Button>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function Actions() {
  const ready = useConnected()
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [skills, setSkills] = useState<Skills | null>(null)
  const [libraryError, setLibraryError] = useState('')
  const [skillsError, setSkillsError] = useState('')
  const [policies, setPolicies] = useState<Policies | null>(null)
  const [revision, setRevision] = useState(0)
  const [editor, setEditor] = useState<Entry | null | undefined>()
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const { act, confirm, notify } = useFeedback()
  const refresh = () => setRevision((v) => v + 1)
  useEffect(() => {
    let live = true
    setLibraryError('')
    http<{ entries: Entry[] }>('/api/actions')
      .then((data) => {
        if (live) setEntries(data.entries)
      })
      .catch((e) => {
        if (live) {
          setEntries(null)
          setLibraryError(message(e))
        }
      })
    return () => {
      live = false
    }
  }, [revision])
  useEffect(() => {
    let live = true
    setSkills(null)
    setPolicies(null)
    setSkillsError('')
    if (ready)
      Promise.all([robot.request<Skills>('robot.skills'), robot.request<Policies>('robot.policies')])
        .then(([data, loaded]) => {
          if (live) { setSkills(data); setPolicies(loaded) }
        })
        .catch((e) => {
          if (live) setSkillsError(message(e))
        })
    return () => {
      live = false
    }
  }, [ready, revision])
  async function activate(entry: Entry) {
    const m = entry.manifest
    if (m.kind === 'perpetual') {
      location.hash = 'settings/policies'
      return
    }
    if (await confirm('注册「' + m.name + '」？', '运行端配置将更新，可能触发重新就位。'))
      if (
        await act(
          () =>
            robot.request('robot.setSkill', {
              name: m.name,
              path: entry.path,
              duration: m.duration_s,
              command: [0, 0, 0],
              unwind: m.command.idle,
              unwind_s: m.unwind_s,
              chain: m.chain,
              action_scale: m.action_scale,
            }),
          '注册请求已完成，请核对运行端动作',
        )
      )
        refresh()
  }
  const filtered = entries?.filter(
    (e) =>
      (filter === 'all' || filter === e.manifest.kind) &&
      [e.manifest.name, e.manifest.description]
        .join(' ')
        .toLowerCase()
        .includes(search.toLowerCase()),
  )
  const available = skills ? skillEntries(skills) : []
  return (
    <div className="flex flex-col gap-5">
      <Heading section="RL 动作 / 本机动作库" title="小鸭的动作收藏。">
        导入训练模型，编辑说明，再选择注册或绑定。
      </Heading>
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-auto text-sm text-muted-foreground">
          {entries ? '已导入 ' + entries.length + ' 个模型' : '读取本机动作库'}
        </span>
        <Button onClick={() => setEditor(null)}>
          <Plus data-icon="inline-start" />
          导入动作
        </Button>
        <Button variant="outline" onClick={refresh}>
          <RefreshCw data-icon="inline-start" />
          刷新
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <ToggleGroup
          type="single"
          variant="outline"
          value={filter}
          onValueChange={(v) => {
            if (v) setFilter(v)
          }}
        >
          {[
            ['all', '全部模型'],
            ['episodic', '单次动作'],
            ['perpetual', '持续策略'],
          ].map(([v, name]) => (
            <ToggleGroupItem key={v} value={v}>
              {name}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <Input
          className="max-w-xs"
          type="search"
          aria-label="搜索动作"
          placeholder="搜索动作"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <Problem>{libraryError}</Problem>
      {filtered &&
        (filtered.length ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {filtered.map((entry) => (
              <Card key={entry.id}>
                <CardHeader>
                  <div className="mb-3 flex items-center justify-between rounded-xl bg-muted p-4">
                    <Duck />
                    <Badge variant="secondary">
                      {entry.manifest.kind === 'episodic' ? '单次动作' : '持续策略'}
                    </Badge>
                  </div>
                  <CardTitle>{entry.manifest.name}</CardTitle>
                  <CardDescription>{entry.manifest.description || '暂无描述'}</CardDescription>
                </CardHeader>
                <CardContent className="text-sm text-muted-foreground">
                  {entry.manifest.duration_s ? entry.manifest.duration_s + ' 秒' : '持续运行'} ·{' '}
                  {(entry.bytes / 1048576).toFixed(2)} MiB
                </CardContent>
                <CardFooter className="flex-wrap gap-2">
                  <Button variant="outline" onClick={() => setEditor(entry)}>
                    查看 / 编辑
                  </Button>
                  <Button variant="link" onClick={() => activate(entry)}>
                    {entry.manifest.kind === 'episodic' ? '注册动作' : '前往策略配置'}
                  </Button>
                </CardFooter>
              </Card>
            ))}
          </div>
        ) : (
          <Blank title={entries?.length ? '没有匹配的动作' : '还没有导入模型'}>
            {entries?.length
              ? '调整类型或搜索文字。'
              : '准备 .onnx 和配套 manifest.json，开始添加第一个动作。'}
          </Blank>
        ))}
      <Panel title="运行端已配置动作" description="配置记录不代表模型已加载。策略与实时反馈就绪后才可试运行，试运行会驱动实物。">
        <Problem>{skillsError}</Problem>
        {skills ? (
          available.length ? (
            <div className="divide-y">
              {available.map((s, i) => (
                <div key={s.name + i} className="flex flex-wrap items-center gap-2 py-2">
                  <div className="mr-auto">
                    <strong className="text-sm">{s.name}</strong>
                    <p className="text-xs text-muted-foreground">
                      {s.duration ? s.duration + ' 秒 · ' : ''}
                      {s.overridden ? '自定义配置' : '运行端动作'}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!policies?.enabled || !robot.fresh() || !(robot.health?.healthy || robot.health?.degraded)}
                    onClick={async () => {
                      if (
                        await confirm(
                          '试运行「' + s.name + '」？',
                          '请确认实物周围有足够的运动空间。',
                        )
                      )
                        await act(
                          () => robot.request('robot.do', { skill: s.name }),
                          '动作请求已接受',
                        )
                    }}
                  >
                    试运行
                  </Button>
                  {s.overridden && (
                    <Button
                      size="sm"
                      variant="link"
                      onClick={async () => {
                        if (
                          await confirm(
                            '移除自定义配置？',
                            '模型文件仍保留，原版动作将恢复默认配置。',
                          )
                        )
                          if (await act(() => robot.request('robot.removeSkill', { name: s.name })))
                            refresh()
                      }}
                    >
                      移除自定义配置
                    </Button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <Blank title="运行端没有提供可用动作" />
          )
        ) : (
          !skillsError && <p className="text-sm text-muted-foreground">等待读取运行端动作…</p>
        )}
      </Panel>
      {editor !== undefined && (
        <Editor
          entry={editor}
          close={() => setEditor(undefined)}
          saved={() => {
            setEditor(undefined)
            refresh()
            notify('已保存到动作库，启用需要单独确认')
          }}
        />
      )}
    </div>
  )
}
