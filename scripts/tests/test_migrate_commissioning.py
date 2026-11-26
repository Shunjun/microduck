"""Only the known temporary commissioning drop-in may be migrated."""
import importlib.util
import fcntl
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location(
    'migration', Path(__file__).resolve().parents[1] / 'migrate-commissioning.py')
migration = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(migration)

LEGACY = '''[Service]
ExecStart=
ExecStart=/opt/robot/daemon/current/bin/robotd --socket /run/robotd.sock --servo-debug --no-policy --port /dev/ttyS0
'''


class MigrationTest(unittest.TestCase):
    def test_migrates_only_known_dropin_and_keeps_other_settings(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            dropin = root / 'etc/systemd/system/robotd.service.d/commissioning.conf'
            dropin.parent.mkdir(parents=True)
            dropin.write_text(LEGACY)
            config = root / 'var/lib/robot/robotd.toml'
            config.parent.mkdir(parents=True)
            config.write_text('[bus]\ndriver = "feetech1910"\nport = "/dev/ttyS2" # old\n\n[policy]\ngain = 8\n')
            config.chmod(0o600)
            original_owner = (config.stat().st_uid, config.stat().st_gid)
            self.assertTrue(migration.migrate(root))
            self.assertEqual(config.stat().st_mode & 0o777, 0o600)
            self.assertEqual((config.stat().st_uid, config.stat().st_gid), original_owner)
            import tomllib
            self.assertEqual(tomllib.loads(config.read_text()), {
                'bus': {'driver': 'feetech1910', 'port': '/dev/ttyS0'}, 'policy': {'gain': 8}})
            self.assertFalse(dropin.exists())
            self.assertEqual(next(dropin.parent.glob('commissioning.conf.*.bak')).read_text(), LEGACY)
            self.assertFalse(migration.migrate(root))

    def test_does_not_rewrite_custom_operator_dropin(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            dropin = root / 'etc/systemd/system/robotd.service.d/commissioning.conf'
            dropin.parent.mkdir(parents=True)
            custom = LEGACY + 'Environment=MY_SETUP=1\n'
            dropin.write_text(custom)
            with self.assertRaisesRegex(ValueError, 'custom'):
                migration.migrate(root)
            self.assertEqual(dropin.read_text(), custom)
            self.assertFalse((root / 'var/lib/robot/robotd.toml').exists())

    def test_old_flag_in_a_comment_does_not_block_updates(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            dropin = root / 'etc/systemd/system/robotd.service.d/commissioning.conf'
            dropin.parent.mkdir(parents=True)
            current = '# --servo-debug was removed\n; prior --servo-debug\n[Service]\nEnvironment=ROBOT_NOTE=ready\n'
            dropin.write_text(current)
            self.assertFalse(migration.migrate(root))
            self.assertEqual(dropin.read_text(), current)

    def test_existing_override_is_replaced_only_by_actual_cli_port(self):
        import tomllib
        for text in ['', '[policy]\ngain=180\n', '[bus]\nport="/dev/ttyUSB0"\n']:
            actual = tomllib.loads(migration.with_port(text, '/dev/ttyS0'))
            self.assertEqual(actual['bus']['port'], '/dev/ttyS0')
            if 'policy' in tomllib.loads(text):
                self.assertEqual(actual['policy'], {'gain': 180})
        with self.assertRaises(ValueError):
            migration.with_port('bus={port="/dev/ttyS2"}\n', '/dev/ttyS0')

    def test_recognizes_no_other_execstart(self):
        for custom in [LEGACY.replace('--servo-debug ', ''),
                       LEGACY.replace(' --no-policy', ' --params /etc/other.toml'),
                       LEGACY.replace('/dev/ttyS0', '/tmp/not-a-port')]:
            with self.assertRaises(ValueError):
                migration.legacy_port(custom)

    def test_waits_for_parameter_lock_and_rereads_after_other_writer(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            dropin = root / 'etc/systemd/system/robotd.service.d/commissioning.conf'
            dropin.parent.mkdir(parents=True)
            dropin.write_text(LEGACY)
            config = root / 'var/lib/robot/robotd.toml'
            config.parent.mkdir(parents=True)
            config.write_text('[bus]\nport="/dev/ttyS2"\n')
            with config.with_suffix('.lock').open('a') as lock:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
                process = subprocess.Popen(
                    [sys.executable, SPEC.origin, '--root', str(root)],
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                try:
                    with self.assertRaises(subprocess.TimeoutExpired):
                        process.communicate(timeout=0.5)
                    config.write_text('[bus]\nport="/dev/ttyS2"\n[policy]\ngain=12\n')
                finally:
                    fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
                    output, error = process.communicate(timeout=5)
            self.assertEqual(process.returncode, 0, output + error)
            import tomllib
            self.assertEqual(tomllib.loads(config.read_text())['policy']['gain'], 12)


if __name__ == '__main__':
    unittest.main()
