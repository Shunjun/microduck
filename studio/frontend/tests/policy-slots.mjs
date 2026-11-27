import test from 'node:test'
import assert from 'node:assert/strict'
import { modelsForSlot, trialSkill } from '../src/lib/policy-slots.ts'

const entry = (name, slot, kind, encoding) => ({ id: name, path: '/models/' + name, bytes: 1, manifest: { name, slot, kind, command: { encoding, idle: [0, 0, 0] } } })

test('policy choices require the right slot, kind and command encoding', () => {
  const entries = [entry('walk-v1', 'walk', 'perpetual', 'constant'), entry('stand-v1', 'stand', 'perpetual', 'constant'), entry('sit-v1', 'sitstand', 'perpetual', 'posture_flag'), entry('bad-sit', 'sitstand', 'perpetual', 'constant'), entry('pick-v1', 'ground_pick', 'perpetual', 'phase'), entry('kick-v1', 'kick_left', 'episodic', 'constant'), entry('general', undefined, 'episodic', 'constant')]
  for (const [slot, name] of [['walk', 'walk-v1'], ['stand', 'stand-v1'], ['sitstand', 'sit-v1'], ['ground_pick', 'pick-v1'], ['kick_left', 'kick-v1']]) {
    assert.deepEqual(modelsForSlot(entries, slot).map((model) => model.id), [name])
  }
  assert.deepEqual(modelsForSlot(entries, 'kick_right'), [])
})

test('trial dispatch uses the special sit toggle and pick handlers', () => {
  assert.equal(trialSkill('sitstand'), 'sit_toggle')
  assert.equal(trialSkill('ground_pick'), 'ground_pick')
  assert.equal(trialSkill('kick_right'), 'kick_right')
  assert.equal(trialSkill('walk'), null)
  assert.equal(trialSkill('stand'), null)
})
