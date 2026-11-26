import test from 'node:test'
import assert from 'node:assert/strict'
import {
  canStartServoCheck,
  canEditZero,
  debugPose,
  finishProblems,
  jointLimits,
  reusablePose,
  reusableImu,
} from '../src/lib/calibration.ts'

const joint = { id: 1, direction: -1, min_ticks: 0, max_ticks: 4095, zero_ticks: 0 }
const complete = {
  settings: Array.from({ length: 15 }, (_, i) => ({ ...joint, id: i + 1 })),
  imu_mount: [1, 0, 0, 0],
  speed_rad_s_per_unit: 0.1,
  current_ma_per_unit: 2,
}

test('completion requires 15 calibrated joints, confirmed IMU and both positive unit scales', () => {
  assert.deepEqual(finishProblems(complete), [])
  for (const fields of [
    { settings: [] },
    { settings: [...complete.settings.slice(1), { ...joint, zero_ticks: null }] },
    { imu_mount: null },
    { speed_rad_s_per_unit: 0 },
    { current_ma_per_unit: -1 },
    { current_ma_per_unit: Infinity },
  ])
    assert.ok(finishProblems({ ...complete, ...fields }).length)
})
test('an unspecified direction or invalid interval cannot advance commissioning', () => {
  assert.equal(jointLimits(joint), true)
  for (const fields of [
    { direction: null },
    { direction: 0 },
    { min_ticks: null },
    { min_ticks: 4095 },
    { max_ticks: 4096 },
    { min_ticks: 0.5 },
  ])
    assert.equal(jointLimits({ ...joint, ...fields }), false)
})

test('a cold tty can reach Enter and Scan before its first successful read', () => {
  assert.equal(canStartServoCheck({ bus_status: 'waiting', restart_required: false }), true)
  assert.equal(canStartServoCheck({ bus_status: 'error', restart_required: false }), true)
  assert.equal(canStartServoCheck({ bus_status: 'reconfiguring', restart_required: false }), false)
  assert.equal(canStartServoCheck({ bus_status: 'ready', restart_required: true }), false)
})

test('reboot can reuse saved calibrations without overwriting fresh measurements', () => {
  const reboot = { ...complete, saved: null, calibration_required: true }
  assert.ok(reusablePose(reboot))
  assert.ok(reusableImu(reboot))
  assert.equal(reusablePose({ ...reboot, candidate: reboot.settings }), false)
  assert.equal(reusableImu({ ...reboot, imu_candidate: [1, 0, 0, 0] }), false)
  assert.equal(reusableImu({ ...reboot, imu_mount: [0, 0, 0, 0] }), false)
})

test('missing or errored servo readings are labelled as reference pose', () => {
  const readings = complete.settings.map((j) => ({ id: j.id, ticks: 128, error: null }))
  const reference = Array(15).fill(0.75)
  for (const invalid of [
    readings.slice(1),
    [{ ...readings[0], error: 'read timeout' }, ...readings.slice(1)],
  ]) {
    const pose = debugPose({ ...complete, reference, readings: invalid }, true)
    assert.match(pose.label, /14 \/ 15/)
    assert.equal(pose.angles[0], reference[0])
  }
})

test('after a saved pose an unloaded servo can be adjusted before commissioning finishes', () => {
  const session = {
    ...complete,
    active: true,
    moving: false,
    mode: 'off',
    calibration_required: true,
  }
  assert.ok(canEditZero(session, joint))
  for (const change of [{ mode: 'hold' }, { moving: true }, { active: false }])
    assert.equal(canEditZero({ ...session, ...change }, joint), false)
  assert.equal(canEditZero(session, { ...joint, zero_ticks: null }), false)
})
