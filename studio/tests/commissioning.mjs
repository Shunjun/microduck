// End-to-end IPC against explicitly fake IO. Requires `cargo build -p robotd` first.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';

const binary = fileURLToPath(new URL('../../target/debug/robotd', import.meta.url));
const work = await mkdtemp(join(tmpdir(), 'duck-wizard-'));
const params = join(work, 'robotd.toml'), calibration = join(work, 'calibration.json'), socketPath = join(work, 'robotd.sock');
let child, socket, log = '', sequence = 0, buffer = '';
const pending = new Map();

function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => { pending.delete(id); reject(Error(method + ' timed out')); }, 12000);
    pending.set(id, { resolve, reject, timeout });
    socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
function data(chunk) {
  buffer += chunk.toString();
  for (let newline; (newline = buffer.indexOf('\n')) !== -1;) {
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const reply = JSON.parse(line), task = pending.get(reply.id);
    if (!task) continue;
    pending.delete(reply.id); clearTimeout(task.timeout);
    if (reply.error) task.reject(Error(reply.error.message)); else task.resolve(reply.result);
  }
}
async function until(check, message) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) { if (await check()) return; await pause(50); }
  throw Error(message);
}
async function stop() {
  socket?.destroy(); socket = undefined;
  if (child && child.exitCode === null) {
    const exited = once(child, 'exit'); child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
    try { await exited; } finally { clearTimeout(timeout); }
  }
  child = undefined; buffer = '';
}
async function start(extra = []) {
  log = '';
  child = spawn(binary, ['--fake', '--no-policy', '--params', params, '--socket', socketPath, '--servo-calibration', calibration, ...extra], { cwd: resolve(fileURLToPath(new URL('../..', import.meta.url))) });
  child.stdout.on('data', b => { log += b; }); child.stderr.on('data', b => { log += b; });
  await until(async () => {
    if (child.exitCode !== null) throw Error('fake robotd exited: ' + log);
    const connection = net.createConnection(socketPath);
    try { await once(connection, 'connect'); socket = connection; return true; }
    catch { connection.destroy(); return false; }
  }, 'fake IPC socket never appeared');
  socket.on('data', data);
  await call('hello', { api_version: 72, client: 'studio-commissioning-test' });
}
const debug = (op, fields = {}) => call('robot.servoDebug', { op, ...fields });

try {
  await writeFile(params, '[bus]\ndriver="feetech1910"\nport="/dev/ttyS0"\n[policy]\nenabled=false\ngain=180\n[safety]\ngain_limp=40\n[audio]\nenabled=false\n');
  await start();
  assert.equal((await call('robot.hardware')).calibration_required, true);
  const before = await readFile(params, 'utf8');
  await assert.rejects(call('robot.setHardware', { servo_driver: 'feetech1910', port: '/dev/ttyS2', normal_p: 255 }), /P/);
  assert.equal(await readFile(params, 'utf8'), before, 'invalid combined settings must not partially save the port');
  await call('robot.setHardware', { servo_driver: 'feetech1910', port: '/dev/ttyS2', normal_p: 8, limp_p: 4 });
  await until(async () => (await call('robot.hardware')).effective_port === '/dev/ttyS2', 'new port was not adopted');
  await until(async () => { try { await debug('enter'); return true; } catch { return false; } }, 'debug unavailable after port change');
  const scan = await debug('scan');
  assert.equal(scan.readings.filter(r => !r.error && r.ticks != null).length, 15);
  await debug('settings', { joints: scan.settings.map(j => ({ ...j, direction: 1, min_ticks: 0, max_ticks: 4095 })) }); // Explicit simulator fixture, never real mechanical limits.
  await assert.rejects(debug('finish'), /calibration|missing|invalid|field/i);
  // Stationary capture deliberately needs a real sampling window, rather than synthetic timestamps.
  await pause(2200);
  await debug('capture'); await debug('save');
  const pose = JSON.parse(await readFile(calibration, 'utf8'));
  await debug('set_zero', { id: 13, ticks: 2100 });
  const adjusted = JSON.parse(await readFile(calibration, 'utf8'));
  assert.deepEqual(adjusted.joints.filter(j => j.id !== 13), pose.joints.filter(j => j.id !== 13));
  assert.equal(adjusted.joints.find(j => j.id === 13).zero_ticks, 2100);
  assert.ok((await readdir(work)).some(name => name.endsWith('.bak')));
  await debug('units', { speed_rad_s_per_unit: .01, current_ma_per_unit: .1 }); // Simulator values only.
  await debug('imu_capture', { mount: [1, 0, 0, 0] }); await debug('imu_save');
  assert.equal(JSON.parse(await readFile(calibration, 'utf8')).commissioning_pending, true);
  await stop(); await start();
  assert.equal((await call('robot.hardware')).calibration_required, true, 'a reboot before Finish must not bypass the wizard');
  await until(async () => { try { await debug('enter'); return true; } catch { return false; } }, 'debug unavailable after restart');
  const finished = await debug('finish');
  assert.equal(finished.calibration_required, false);
  await until(async () => !(await call('robot.hardware')).calibration_required, 'normal state did not resume');
  assert.equal(JSON.parse(await readFile(calibration, 'utf8')).commissioning_pending, undefined);
  await stop();

  await start(['--port', '/dev/ttyS7']);
  const overridden = await call('robot.hardware');
  assert.equal(overridden.configured_port, '/dev/ttyS2');
  assert.equal(overridden.effective_port, '/dev/ttyS7');
  assert.equal(overridden.port_override, true);
  const locked = await readFile(params, 'utf8');
  await assert.rejects(call('robot.setHardware', { servo_driver: 'feetech1910', port: '/dev/ttyS0' }), /--port|override/i);
  assert.equal(await readFile(params, 'utf8'), locked);
  await call('robot.setHardware', { servo_driver: 'feetech1910', normal_p: 6 });
  assert.equal((await call('robot.hardware')).normal_p, 6, 'CLI port override must not lock gain editing');
  console.log('PASS: fake commissioning, atomic hardware edit, safe port handover, individual zero, independent IMU/units, reboot persistence, explicit finish, CLI override.');
} catch (error) {
  console.error(log.slice(-4000)); throw error;
} finally {
  await stop();
  for (const task of pending.values()) { clearTimeout(task.timeout); task.reject(Error('test stopped')); }
  await rm(work, { recursive: true, force: true });
}
