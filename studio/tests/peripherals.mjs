// Real IPC/TOML against explicitly fake I/O; never opens physical devices.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as pause } from 'node:timers/promises'
const root = fileURLToPath(new URL('../..', import.meta.url))
const work = await mkdtemp(join(tmpdir(), 'duck-peripherals-'))
const config = join(work, 'robotd.toml'), path = join(work, 'robotd.sock')
let child, sequence = 0, log = ''
async function call(method, params = {}) {
  const socket = net.createConnection(path)
  const timer = setTimeout(() => socket.destroy(Error('IPC timed out')), 10000)
  try {
    await once(socket, 'connect')
    socket.write(JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params }) + '\n')
    let text = ''
    for await (const bytes of socket) {
      text += bytes
      if (text.length > 262144) throw Error('oversized response')
      if (!text.includes('\n')) continue
      const response = JSON.parse(text.slice(0, text.indexOf('\n')))
      if (response.error) throw Error(response.error.message)
      return response.result
    }
    throw Error('IPC closed without response')
  } finally { clearTimeout(timer); socket.destroy() }
}
async function start() {
  child = spawn(join(root, 'target/debug/robotd'), ['--fake', '--no-policy', '--params', config, '--socket', path], { cwd: root })
  child.stdout.on('data', b => { log += b }); child.stderr.on('data', b => { log += b })
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw Error('fake robotd exited: ' + log)
    try { return await call('robot.peripherals') } catch { await pause(50) }
  }
  throw Error('peripheral IPC unavailable: ' + log)
}
async function stop() {
  if (child && child.exitCode === null) {
    const exited = once(child, 'exit'); child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
    try { await exited } finally { clearTimeout(timer) }
  }
  child = undefined
}
try {
  await writeFile(config, '# retained\n[policy]\nenabled=false\n[audio]\nenabled=false\n[media]\nsource="test"\n')
  const initial = await start()
  assert.equal(initial.microphone_device, 'none'); assert.equal(initial.speaker_device, 'none')
  for (const key of ['microphones', 'speakers', 'cameras']) assert.ok(initial[key].some(d => d.id === 'none'))
  assert.equal(initial.restart_units.includes('mediad'), false)
  const before = await readFile(config, 'utf8')
  await assert.rejects(call('robot.setPeripherals', { microphone_device: 'default', speaker_volume: 101 }))
  await assert.rejects(call('robot.setPeripherals', { speaker_device: 'none', camera_device: '/tmp/not-a-camera' }))
  assert.equal(await readFile(config, 'utf8'), before, 'invalid updates must not save partial choices')
  let saved = await call('robot.setPeripherals', { microphone_device: 'default', speaker_device: 'none', camera_device: 'none', speaker_volume: 0, camera_quality: '720p15' })
  assert.equal(saved.microphone_device, 'default', 'an explicit microphone enables only capture despite old audio gate')
  assert.equal(saved.speaker_device, 'none'); assert.equal(saved.speaker_volume, 0)
  assert.equal(saved.camera_device, 'none'); assert.equal(saved.camera_quality, '720p15')
  assert.ok(saved.restart_units.includes('robotd')); assert.ok((await readFile(config, 'utf8')).includes('# retained'))
  await stop(); saved = await start()
  assert.equal(saved.microphone_device, 'default'); assert.equal(saved.speaker_device, 'none')
  assert.equal(saved.camera_device, 'none'); assert.equal(saved.speaker_volume, 0)
  assert.equal(saved.restart_units.includes('robotd'), false)
  saved = await call('robot.setPeripherals', { microphone_device: 'none', speaker_device: 'none' })
  assert.equal(saved.microphone_device, 'none'); assert.equal(saved.speaker_device, 'none')
  await call('robot.servoDebug', { op: 'enter' })
  assert.equal((await call('robot.peripherals')).camera_device, 'none')
  saved = await call('robot.setPeripherals', { speaker_volume: 25 })
  assert.equal(saved.speaker_volume, 25, 'peripheral configuration remains accessible during servo debug')
  console.log('PASS: fake peripheral IPC, independent none, explicit selection, atomic refusal, persistence, zero volume and restart reporting')
} finally { await stop(); await rm(work, { recursive: true, force: true }) }
