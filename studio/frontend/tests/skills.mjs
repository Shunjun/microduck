import test from 'node:test'
import assert from 'node:assert/strict'
import { skillEntries, quickSkillNames } from '../src/lib/skills.ts'

test('current robot.skills omits empty built_in and yields a real empty library', () => {
  assert.deepEqual(skillEntries(JSON.parse('{"skills":[]}')), [])
})

test('listed and built-in skills both remain available', () => {
  const trained = { name: 'wave', overridden: true, duration: 2 }
  assert.deepEqual(skillEntries({ skills: [trained], built_in: ['sit_toggle'] }), [
    trained, { name: 'sit_toggle', overridden: false, duration: undefined },
  ])
})

test('configured defaults are not offered as runnable actions when policies are disabled', () => {
  const configured = { skills: [{ name: 'roulade', overridden: false }] }
  assert.deepEqual(quickSkillNames(configured, { enabled: false, skills: ['roulade'] }), [])
  assert.deepEqual(quickSkillNames(configured, { enabled: true, skills: [] }), [])
  assert.deepEqual(quickSkillNames(configured, { enabled: true, skills: ['roulade'] }), ['roulade'])
})
