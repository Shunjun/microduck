import assert from 'node:assert/strict'
import test from 'node:test'
import { deviceChoices, peripheralUpdate } from '../src/lib/peripherals.ts'

const current = {
  microphone_device: 'default', speaker_device: 'default', camera_device: '/dev/video0',
  speaker_volume: 50, camera_quality: '720p30', camera_port_override: false,
}

test('choosing no microphone preserves speaker and camera settings', () => {
  assert.deepEqual(peripheralUpdate({ ...current, microphone_device: 'none' }, current), { microphone_device: 'none' })
})
test('no speaker and a zero volume are saved without disabling microphone', () => {
  assert.deepEqual(peripheralUpdate({ ...current, speaker_device: 'none', speaker_volume: 0 }, current), { speaker_device: 'none', speaker_volume: 0 })
})
test('camera none is persisted and invalid drafts never produce a partial update', () => {
  assert.deepEqual(peripheralUpdate({ ...current, camera_device: 'none' }, current), { camera_device: 'none' })
  assert.throws(() => peripheralUpdate({ ...current, speaker_device: 'none', camera_quality: '4k120' }, current))
  assert.throws(() => peripheralUpdate({ ...current, speaker_volume: 101 }, current))
  assert.throws(() => peripheralUpdate({ ...current, microphone_device: '   ' }, current))
})
test('explicit camera command-line override cannot be changed by the form', () => {
  assert.throws(() => peripheralUpdate({ ...current, camera_device: '/dev/video2' }, { ...current, camera_port_override: true }))
  assert.deepEqual(peripheralUpdate({ ...current, speaker_volume: 60 }, { ...current, camera_port_override: true }), { speaker_volume: 60 })
})
test('explicitly choosing the saved camera still sends selection to exit a legacy test source', () => {
  assert.deepEqual(peripheralUpdate(current, current, true), { camera_device: '/dev/video0' })
  assert.deepEqual(peripheralUpdate(current, { ...current, camera_port_override: true }, true), {})
})
test('device choices retain missing saved devices and expose a single none choice', () => {
  const options = deviceChoices([{ id: 'none', label: '无', available: true }, { id: 'default', label: '系统默认', available: true }], 'plughw:missing')
  assert.equal(options.filter((option) => option.id === 'none').length, 1)
  assert.deepEqual(options.find((option) => option.id === 'plughw:missing'), { id: 'plughw:missing', label: 'plughw:missing', available: false })
})
