import test from 'node:test'
import assert from 'node:assert/strict'
import { actionName } from '../src/lib/action-name.ts'

test('Chinese aliases are preferred without changing the command identifier', () => {
  const model = { alias: ' 挥挥手 ', manifest: { name: 'wave_hand' } }
  assert.equal(actionName(model), '挥挥手')
  assert.equal(model.manifest.name, 'wave_hand')
  for (const alias of [undefined, '', '  ']) assert.equal(actionName({ ...model, alias }), 'wave_hand')
})
