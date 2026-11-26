#!/usr/bin/env python3
"""Retire the exact temporary commissioning unit; never rewrite custom units.

Requires Python 3.11+, available on supported Debian 12/13 boards. The user-layer
port retains the formerly effective CLI setting. Backups remain beside both files.
"""
import argparse
import copy
import fcntl
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import tempfile
import time
import tomllib


def legacy_port(text: str) -> str:
    lines = [line.strip() for line in text.splitlines()
             if line.strip() and not line.lstrip().startswith(('#', ';'))]
    if len(lines) != 3 or lines[:2] != ['[Service]', 'ExecStart=']:
        raise ValueError('custom commissioning.conf; remove obsolete --servo-debug manually')
    prefix = 'ExecStart=/opt/robot/daemon/current/bin/robotd '
    if not lines[2].startswith(prefix):
        raise ValueError('custom commissioning command; migration refused')
    args = shlex.split(lines[2][len(prefix):])
    # //Compatible: only the temporary unit created for first-install commissioning.
    if len(args) != 6 or args[:4] != ['--socket', '/run/robotd.sock', '--servo-debug', '--no-policy']:
        raise ValueError('custom commissioning arguments; migration refused')
    if args[4] != '--port' or not re.fullmatch(r'/dev/tty(?:S|USB|ACM)\d+', args[5]):
        raise ValueError('custom commissioning serial port; migration refused')
    return args[5]


def with_port(text: str, port: str) -> str:
    before = tomllib.loads(text)
    expected = copy.deepcopy(before)
    expected.setdefault('bus', {})['port'] = port
    lines = text.splitlines(keepends=True)
    bus_start = next((i for i, line in enumerate(lines)
                      if re.fullmatch(r'\s*\[bus\]\s*(?:#.*)?\n?', line)), None)
    value = 'port = ' + json.dumps(port) + '\n'
    if bus_start is None:
        changed = text.rstrip() + '\n\n[bus]\n' + value
    else:
        bus_end = next((i for i in range(bus_start + 1, len(lines))
                        if re.match(r'\s*\[', lines[i])), len(lines))
        index = next((i for i in range(bus_start + 1, bus_end)
                      if re.match(r'\s*port\s*=', lines[i])), None)
        if index is None:
            if not lines[bus_start].endswith('\n'):
                lines[bus_start] += '\n'
            lines.insert(bus_start + 1, value)
        else:
            lines[index] = value
        changed = ''.join(lines)
    # A parser comparison refuses unusual TOML rather than guessing at its meaning.
    if tomllib.loads(changed) != expected:
        raise ValueError('cannot safely preserve custom TOML while migrating port')
    return changed


def atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        shutil.copy2(path, path.with_name(path.name + f'.{time.time_ns()}.bak'))
    previous = path.stat() if path.exists() else None
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name, dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            if previous is not None:
                os.fchown(stream.fileno(), previous.st_uid, previous.st_gid)
            os.fchmod(stream.fileno(), (previous.st_mode & 0o777) if previous else 0o644)
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        sync_directory(path.parent)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def sync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def migrate(root: Path) -> bool:
    dropin = root / 'etc/systemd/system/robotd.service.d/commissioning.conf'
    if not dropin.exists():
        return False
    text = dropin.read_text()
    active = [line.strip() for line in text.splitlines()
              if not line.lstrip().startswith(('#', ';'))]
    if not any(line.startswith('ExecStart=') and '--servo-debug' in line for line in active):
        return False
    port = legacy_port(text)
    config = root / 'var/lib/robot/robotd.toml'
    config.parent.mkdir(parents=True, exist_ok=True)
    # Same sidecar and flock as robotd-params::edit; the lock outlives atomic replacement.
    with config.with_suffix('.lock').open('a') as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        current = config.read_text() if config.exists() else ''
        changed = with_port(current, port)
        # Make the port durable before retiring its override. Interruption is retryable.
        atomic_write(config, changed)
        backup = dropin.with_name(dropin.name + f'.{time.time_ns()}.bak')
        dropin.rename(backup)
        sync_directory(dropin.parent)
    print(f'commissioning migration: preserved {port} in {config}; retired {dropin}; backup {backup}')
    return True


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path('/'))
    args = parser.parse_args()
    try:
        migrate(args.root)
    except (OSError, ValueError) as error:
        parser.exit(1, f'commissioning migration failed: {error}\n')


if __name__ == '__main__':
    main()
