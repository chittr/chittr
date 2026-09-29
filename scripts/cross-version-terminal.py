"""One terminal process lifetime for the #58 cross-version cycle.

Launches an explicit built entry point through a raw-mode PTY against isolated
--state-dir storage, performs the requested composer actions, closes it with
Ctrl+D and reports what the saved state and the process showed. Terminal text
is discarded: the result holds identities, counts and outcomes only.

scripts/cross-version-cycle.ts is the only intended caller.
"""
import argparse, fcntl, json, os, pathlib, pty, re, select, shutil, struct, subprocess
import sys, termios, time

parser = argparse.ArgumentParser()
parser.add_argument('--entry', required=True)
parser.add_argument('--workspace', required=True)
parser.add_argument('--state-dir', required=True)
parser.add_argument('--session')
parser.add_argument('--actions', required=True)
args = parser.parse_args()
state = pathlib.Path(args.state_dir)
session_id = re.compile(r'^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$')


def sessions():
    return {path.parent.name: path for path in state.glob('*/*/session.json')
            if session_id.match(path.parent.name)}


before = set(sessions())
command = [shutil.which('node'), args.entry]
if args.session:
    command += ['resume', args.session]
command += ['--state-dir', str(state)]
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 32, 120, 0, 0))
proc = subprocess.Popen(command, cwd=args.workspace, stdin=slave, stdout=slave, stderr=slave,
                        start_new_session=True)
os.close(slave)
output = bytearray()


def collect(seconds=0.1):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        ready, _, _ = select.select([master], [], [], max(0, until - time.monotonic()))
        if ready:
            try:
                output.extend(os.read(master, 65536))
            except OSError:
                return
        if len(output) > 1000000:
            del output[:-200000]


def current():
    known = sessions()
    target = args.session or next((name for name in known if name not in before), None)
    if not target or target not in known:
        return {}
    try:
        return json.loads(known[target].read_text())
    except (OSError, ValueError):
        return {}  # Mid-rename; the next poll reads the committed file.


def wait(predicate, what, seconds=30):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        collect()
        if predicate():
            return
        if proc.poll() is not None:
            raise AssertionError(f'{what}: process exited early')
    raise AssertionError(f'{what}: timed out')


def send(value):
    os.write(master, value if isinstance(value, bytes) else value.encode())
    collect(0.25)


result = {'pid': proc.pid, 'terminated': False, 'listedAttachmentIds': [], 'error': None}
try:
    wait(lambda: '›'.encode() in output, 'composer prompt')
    collect(1.0)
    for action in json.loads(args.actions):
        kind = action['do']
        # Ctrl+O opens the attachment input already holding "/attach ".
        if kind == 'attach':
            count = len(current().get('composerAttachments', []))
            send(b'\x0f'); send(json.dumps(action['path'])); send(b'\r')
            wait(lambda: len(current().get('composerAttachments', [])) == count + 1, 'staged image')
        elif kind == 'remove-last':
            staged = current().get('composerAttachments', [])
            result['removedAttachmentId'] = staged[-1]['id']
            send(b'\x0f'); send(f"--remove {staged[-1]['id']}"); send(b'\r')
            wait(lambda: len(current().get('composerAttachments', [])) == len(staged) - 1,
                 'removed image')
        elif kind == 'type':
            send(action['text'])
            wait(lambda: current().get('composerDraft') == action['expect'], 'saved draft text')
        elif kind == 'enter':
            send(b'\r')
            wait(lambda: len(current().get('messages', [])) == action['messages'], 'sent message')
        elif kind == 'pin':
            send(f"/pin #{action['message']}"); send(b'\r')
            wait(lambda: action['message'] in current().get('pinnedMessageIds', []), 'saved pin')
        elif kind == 'list':
            mark = len(output)
            send(b'\x0f'); send('--list'); send(b'\r'); collect(1.0)
            seen = output[mark:].decode('utf8', 'replace')
            result['listedAttachmentIds'] = sorted(set(re.findall(r'att-[\da-f]{32}', seen)))
        else:
            raise AssertionError(f'unknown action {kind}')
except AssertionError as error:
    result['error'] = str(error)
finally:
    if proc.poll() is None:
        send(b'\x04')
        try:
            proc.wait(timeout=20)
        except subprocess.TimeoutExpired:
            result['terminated'] = True
            proc.terminate()
            proc.wait(timeout=10)
    collect(0.3)
    os.close(master)
saved = re.findall(r'Saved conversation ([\da-f-]{36})\.', output.decode('utf8', 'replace'))
result.update({
    'exitCode': proc.returncode,
    'savedConversationId': saved[-1] if saved else None,
    'createdSessionIds': sorted(set(sessions()) - before),
    'sessionDirectories': sorted(path.name for path in state.iterdir() if path.is_dir()),
    'lockPresentAfterExit': any(state.glob('*/room.lock')),
})
print(json.dumps(result))
sys.exit(1 if result['error'] else 0)
