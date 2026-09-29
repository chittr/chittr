"""Exercise real CLI startup and resume in a PTY without launching provider CLIs."""
import fcntl
import json
import os
import pathlib
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import time

repo = pathlib.Path(__file__).resolve().parents[1]
base = pathlib.Path(tempfile.mkdtemp(prefix='chittr-resume-')).resolve()
state = base / 'state'
project = base / 'project'
command = [shutil.which('node'), '--import', str(repo / 'node_modules/tsx/dist/loader.mjs'),
           str(repo / 'src/cli.ts'), '--state-dir', str(state)]
config = '''version: 1
human: {name: Tester}
skills: {enabled: false}
permissions: {edits: false, commands: false, network: false}
agents:
  fixture: {provider: codex, enabled: false, model: gpt-6-astra, effort: high}
  gemini: {provider: antigravity, enabled: false}
'''


def configure(directory):
    (directory / '.agents').mkdir(parents=True)
    (directory / '.agents' / 'chittr.yaml').write_text(config)


def saved(directory):
    return {data['id']: data for path in state.glob('*/*/session.json')
            if (data := json.loads(path.read_text()))['workspace'] == str(directory)}


def snapshot():
    return {str(path): path.read_bytes() for path in state.rglob('*.json')}


class Terminal:
    def __init__(self, directory, *args):
        self.output = bytearray()
        self.master, self.slave = pty.openpty()
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack('HHHH', 28, 110, 0, 0))
        self.original = termios.tcgetattr(self.slave)
        self.proc = subprocess.Popen(command + list(args), cwd=directory, stdin=self.slave,
                                     stdout=self.slave, stderr=self.slave, start_new_session=True)

    def collect(self, seconds=0.1):
        until = time.monotonic() + seconds
        while time.monotonic() < until:
            ready, _, _ = select.select([self.master], [], [], max(0, until - time.monotonic()))
            if ready:
                try:
                    self.output.extend(os.read(self.master, 65536))
                except OSError:
                    return

    def frame(self):
        frame = bytes(self.output).rsplit(b'\x1b[?25l\x1b[H', 1)[-1].decode(errors='replace')
        return re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', frame)

    def wait(self, condition):
        until = time.monotonic() + 8
        while time.monotonic() < until:
            self.collect()
            if condition():
                return
        raise AssertionError(self.frame())

    def text(self, text):
        self.wait(lambda: text in self.frame())

    def send(self, data):
        os.write(self.master, data)
        self.collect()

    def exited(self, code=0):
        self.wait(lambda: self.proc.poll() is not None)
        assert self.proc.returncode == code, self.frame()
        # Keep the slave open so we can verify the actual terminal modes after exit.
        assert termios.tcgetattr(self.slave) == self.original, 'Terminal modes were not restored'

    def __enter__(self):
        return self

    def __exit__(self, *_):
        if self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait()
        os.close(self.master)
        os.close(self.slave)


def new_chat(directory, message):
    before = saved(directory)
    with Terminal(directory) as terminal:
        terminal.text('CHITTR')
        terminal.wait(lambda: len(saved(directory)) == len(before) + 1)
        current = next(data for id, data in saved(directory).items() if id not in before)
        assert current['messages'] == [], 'Plain chittr resumed old history'
        assert current.get('composerDraft', '') == '', 'Plain chittr restored an old draft'
        assert current['paused'] is False, 'A fresh room should not start paused'
        terminal.send(('@human ' + message + '\r').encode())
        terminal.wait(lambda: saved(directory)[current['id']]['messages'][-1:]
                      and saved(directory)[current['id']]['messages'][-1]['text'] == message)
        terminal.send(b'Retained draft\x04')
        terminal.exited()
        assert b'Run chittr resume here' in terminal.output
    assert saved(directory)[current['id']]['composerDraft'] == 'Retained draft'
    return current['id']


try:
    configure(project)
    first = new_chat(project, 'First conversation marker')
    second = new_chat(project, 'Second conversation marker')
    assert first != second
    assert len(saved(project)) == 2
    # Even a broken old latest pointer must not affect a fresh launch.
    latest = next(state.glob('*/latest.json'))
    latest.write_text('broken old pointer')
    third = new_chat(project, 'Third conversation marker')
    assert len(saved(project)) == 3

    nested = project / 'nested'
    configure(nested)
    nested_id = new_chat(nested, 'Nested directory only')
    sibling = base / 'sibling'
    configure(sibling)
    new_chat(sibling, 'Sibling directory only')

    before = snapshot()
    with Terminal(project, 'resume') as terminal:
        terminal.text('Resume a chat')
        frame = terminal.frame()
        assert frame.index('Third conversation') < frame.index('Second conversation') < frame.index('First conversation')
        assert 'Nested directory only' not in frame and 'Sibling directory only' not in frame
        assert snapshot() == before, 'Browsing history modified saved chats'
        terminal.send(b'\x1b[B\r')
        terminal.text('CHITTR')
        terminal.text('Second conversation marker')
        assert 'First conversation marker' not in terminal.frame()
        assert 'Retained draft' in terminal.frame()
        terminal.wait(lambda: saved(project)[second]['paused'] is False)
        terminal.send(b'\x04')
        terminal.exited()
    assert len(saved(project)) == 3, 'Resuming must not allocate a new chat'
    assert json.loads(latest.read_text())['id'] == second

    # Search and selection operate on this directory's history, including its IDs.
    with Terminal(project, 'resume') as terminal:
        terminal.text('Resume a chat')
        terminal.send(b'First conversation')
        terminal.text('1 of 3 chats')
        assert 'Second conversation marker' not in terminal.frame()
        terminal.send(b'\r')
        terminal.text('CHITTR')
        terminal.text('First conversation marker')
        terminal.wait(lambda: saved(project)[first]['paused'] is False)
        terminal.send(b'\x04')
        terminal.exited()
    assert json.loads(latest.read_text())['id'] == first

    # Cancellation and signals must restore terminal modes and release the workspace lock.
    # Invalid config also proves neither setup nor providers run before choosing a chat.
    config_path = project / '.agents' / 'chittr.yaml'
    config_path.write_text('invalid: [')
    before = snapshot()
    for cancellation in ('escape', 'ctrl-c', 'SIGTERM'):
        with Terminal(project, 'resume') as terminal:
            terminal.text('Resume a chat')
            if cancellation == 'SIGTERM':
                terminal.proc.send_signal(signal.SIGTERM)
            else:
                terminal.send(b'\x1b' if cancellation == 'escape' else b'\x03')
            terminal.exited()
            assert 'Resume cancelled.' in terminal.frame()
            assert b'\x1b[?2004l\x1b[?25h\x1b[0m\x1b[?1049l' in terminal.output
        assert snapshot() == before, 'Cancelling history modified saved chats'
        assert not list(state.glob('*/room.lock')), 'Cancellation left the workspace locked'
    config_path.write_text(config)

    for args in [('resume', third), ('--session', second)]:
        with Terminal(project, *args) as terminal:
            terminal.text('CHITTR')
            assert 'Resume a chat' not in terminal.frame()
            messages = saved(project)[args[1]]['messages']
            terminal.wait(lambda: saved(project)[args[1]]['paused'] is False)
            terminal.send(b'\x15/part\t\r')
            terminal.text('Provider: codex · Model: gpt-6-astra · Effort: high')
            terminal.text('Provider: antigravity · Model: provider default · Effort: provider default')
            terminal.text('Connection: unavailable · Status: Unavailable')
            terminal.text('Queue: 0 queued · 0 at follow-up limit · 0 unresolved')
            assert saved(project)[args[1]]['messages'] == messages, '/participants must not send a chat message'
            terminal.send(b'\x04')
            terminal.exited()
        assert json.loads(latest.read_text())['id'] == args[1]

    with Terminal(nested, 'resume') as terminal:
        terminal.text('Resume a chat')
        assert 'Nested directory only' in terminal.frame()
        assert 'First conversation marker' not in terminal.frame(), 'Parent history leaked into nested directory'
        terminal.send(b'\x1b')
        terminal.exited()
    before = snapshot()
    with Terminal(project, 'resume', nested_id) as terminal:
        terminal.exited(1)
        assert 'CHITTR' not in terminal.frame(), 'Direct IDs must obey directory scope too'
    assert snapshot() == before

    empty = base / 'empty'
    configure(empty)
    (empty / '.agents' / 'chittr.yaml').write_text('invalid: [')
    with Terminal(empty, 'resume') as terminal:
        terminal.exited()
        assert 'No saved chats in this directory' in terminal.frame()
        assert b'\x1b[?1049h' not in terminal.output
    assert saved(empty) == {}
    assert not list(state.glob('*/room.lock'))
    noninteractive = subprocess.run(command + ['resume', '--web'], cwd=project,
                                   capture_output=True, text=True, timeout=8)
    assert noninteractive.returncode == 1
    assert 'interactive terminal' in noninteractive.stderr
    assert snapshot() == before
    trusted_project = base / 'trusted-project'
    configure(trusted_project)
    trust_config = trusted_project / '.agents' / 'chittr.yaml'
    trust_config.write_text(config.replace('edits: false, commands: false, network: false',
                                         'edits: true, commands: true, network: true'))
    with Terminal(trusted_project, '--trusted-commands') as terminal:
        terminal.text('Trusted commands:')
        terminal.wait(lambda: bool(saved(trusted_project)))
        trusted_id = next(iter(saved(trusted_project)))
        assert saved(trusted_project)[trusted_id]['commandMode'] == 'trusted'
        terminal.send(b'/new\r')
        terminal.wait(lambda: len(saved(trusted_project)) == 2)
        assert all(s['commandMode'] == 'trusted' for s in saved(trusted_project).values())
        terminal.send(b'/quit\r')
        terminal.exited()
    with Terminal(trusted_project, 'resume', trusted_id) as terminal:
        terminal.text('commands sandboxed')
        terminal.wait(lambda: saved(trusted_project)[trusted_id]['commandMode'] == 'sandboxed')
        terminal.send(b'/quit\r')
        terminal.exited()
    trust_config.write_text(config)
    with Terminal(trusted_project, '--trusted-commands') as terminal:
        terminal.exited(1)
        assert '--trusted-commands requires' in terminal.frame()
        assert b'\x1b[?1049h' not in terminal.output
    print('PASS CLI PTY: trusted launch flag, visible account access, same-process new chat, '
          'resume without inherited trust, conflicting flag rejected before UI startup')
    print('PASS CLI PTY: fresh launches, active resume, local history ordering, keyboard/search selection, restored draft, '
          'explicit IDs, participant details and completion, directory isolation, empty history, '
          'cancellation/signals, terminal restoration and locks')
finally:
    shutil.rmtree(base)
