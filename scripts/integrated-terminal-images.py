"""Opt-in #57 integrated acceptance via actual raw-mode dist/cli.js. No transcript retained.

Scenarios, each a separate row:
  mixed       one image to Codex, Claude, Grok and unsupported Antigravity in one send
  compaction  actual product maintenance, then retrieval and a new image, for one provider
  restart     orderly idle same-build host restart, then retrieval and a new image
"""
import argparse, binascii, fcntl, hashlib, json, os, pathlib, pty, random, re, select
import shutil, struct, subprocess, tempfile, termios, time, zlib
from datetime import datetime, timezone
import sys; sys.dont_write_bytecode = True  # an untracked __pycache__ would stop the TypeScript harnesses
from integrated_outcomes import unsupported_passed
parser = argparse.ArgumentParser()
parser.add_argument('--scenario', choices=['mixed', 'compaction', 'restart'], required=True)
parser.add_argument('--provider', choices=['codex', 'claude', 'grok'])
parser.add_argument('--room', choices=['restricted', 'trusted'], required=True)
parser.add_argument('--trusted-commands', action='store_true')
parser.add_argument('--output', required=True)
args = parser.parse_args()
granted = args.room == 'trusted'
# #57's trusted row is command mode trusted for every provider, Grok included (#69).
assert args.trusted_commands == granted, 'Trusted room requires --trusted-commands; restricted cannot grant it'
assert (args.scenario == 'mixed') == (args.provider is None), 'Continuity names one --provider; mixed names none'
supported = ['codex', 'claude', 'grok'] if args.scenario == 'mixed' else [args.provider]
unsupported = 'antigravity' if args.scenario == 'mixed' else None
repo = pathlib.Path(__file__).resolve().parents[1]
root = pathlib.Path(tempfile.mkdtemp(prefix='integrated-terminal-images-', dir='/private/tmp'))
workspace = root/'workspace'; (workspace/'.agents').mkdir(parents=True)
state = root/'state'; observation = root/'observation'; observation.mkdir()
value = str(granted).lower()
requested = {'codex': {'model': 'gpt-6-astra', 'effort': 'xhigh'}, 'claude': {'model': 'opus', 'effort': 'xhigh'}, 'grok': {'effort': 'high'} if granted else {}}
def agent_yaml(name):
    enabled = name in supported or name == unsupported
    extra = ''.join(f', {k}: {v}' for k, v in requested.get(name, {}).items()) if name in supported else ''
    return f'  {name}: {{provider: {name}, enabled: {str(enabled).lower()}{extra}}}\n'
(workspace/'.agents/chittr.yaml').write_text(f'''version: 1
human: {{name: Tester}}
skills: {{enabled: {value}}}
permissions: {{edits: {value}, commands: {value}, network: {value}}}
agents:
''' + ''.join(agent_yaml(name) for name in ['codex', 'claude', 'grok', 'antigravity']))
colors = [('red',(255,0,0)),('green',(0,160,0)),('blue',(0,0,255)),('yellow',(255,255,0)),('cyan',(0,255,255)),('purple',(128,0,128)),('black',(0,0,0)),('white',(255,255,255))]
rng = random.SystemRandom()
def chunk(name, data):
    return struct.pack('>I',len(data))+name+data+struct.pack('>I',binascii.crc32(name+data)&0xffffffff)
def png(panels, panel_width):
    width = len(panels)*panel_width
    raw = b''.join(b'\0'+b''.join(bytes(panels[x//panel_width][1]) for x in range(width)) for _ in range(160))
    return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',width,160,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(raw))+chunk(b'IEND',b'')
def whole_image():
    palette = colors[:]; rng.shuffle(palette)
    return png(palette, 80), ','.join(c[0] for c in palette)
def region_image(recipients):
    # Mirrors scripts/integrated-image-oracle.ts: disjoint three-panel regions,
    # adjacent panels differ, and no two recipients share an expected answer.
    while True:
        panels = []
        for _ in range(3*len(recipients)):
            panels.append(rng.choice([c for c in colors if not panels or c != panels[-1]]))
        answers = {r: ','.join(c[0] for c in panels[3*i:3*i+3]) for i, r in enumerate(recipients)}
        if len(set(answers.values())) == len(answers): return png(panels, 72), answers
whole_ask = 'Name the colors of the eight vertical panels from left to right. Use each exact color name from red, green, blue, yellow, cyan, purple, black, white as seen. Reply only to human with a comma-separated list, no spaces or explanation.'
if args.scenario == 'mixed':
    image, answers = region_image(supported); fixtures = [(image, None)]; oracles = list(answers.values())
else:
    fixtures = [whole_image() for _ in range(3)]; oracles = [f[1] for f in fixtures]; answers = {}
paths = []
for i, (data, _) in enumerate(fixtures):
    path = root/f'image-{i}.png'; path.write_bytes(data); paths.append(path)
sha = lambda data: hashlib.sha256(data).hexdigest()
control = {'phase': 'warmup', 'hiddenId': '', 'oracles': oracles}
def phase(name):
    control['phase'] = name
    temporary = observation/'private-control.tmp'; temporary.write_text(json.dumps(control)); temporary.replace(observation/'private-control.json')
phase('warmup')
command = [shutil.which('node'), '--import', str(repo/'scripts/integrated-terminal-observer.mjs'), str(repo/'dist/cli.js'), '--state-dir', str(state)]
if args.trusted_commands: command.append('--trusted-commands')
record = {'issue': 57, 'scenario': args.scenario, 'startedAt': datetime.now(timezone.utc).isoformat(), 'entryPoint': 'built dist/cli.js raw-mode PTY', 'room': args.room,
    'requested': {name: {'model': requested[name].get('model', 'provider default'), 'effort': requested[name].get('effort', 'provider default')} for name in supported},
    'source': {'commit': subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip(), 'patchSha256': hashlib.sha256(subprocess.check_output(['git','diff','--binary','HEAD'],cwd=repo)).hexdigest()}, 'status': 'pending'}
ansi = re.compile(r'\x1b\[[0-9;?]*[ -/]*[@-~]')
class Terminal:
    def __init__(self, session=None):
        self.master, slave = pty.openpty(); fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH',32,120,0,0))
        env = dict(os.environ); env['CHITTR_IMAGE_OBSERVATION'] = str(observation); env['CHITTR_IMAGE_OBSERVERS'] = ','.join(supported)
        self.proc = subprocess.Popen(command+(['--session',session] if session else []), cwd=workspace, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave); os.set_blocking(self.master, False); self.watch = None; self.seen = False; self.recent = ''
    def collect(self, seconds=.05):
        end = time.monotonic()+seconds
        while time.monotonic() < end:
            ready,_,_ = select.select([self.master],[],[],max(0,end-time.monotonic()))
            if ready:
                try: text = os.read(self.master, 65536)
                except OSError: return
                # Terminal text is discarded. A watch holds a short in-memory tail, since one
                # render can span reads, and keeps a single boolean from it and nothing else.
                if self.watch and not self.seen:
                    self.recent = (self.recent+ansi.sub('', text.decode('utf8', 'ignore')))[-20000:]
                    self.seen = all(part in re.sub(r'\s+', ' ', self.recent) for part in self.watch)
                elif not self.watch: self.recent = ''
    def send(self, value):
        data = value if isinstance(value, bytes) else value.encode()
        offset = 0; end = time.monotonic()+30
        while offset < len(data):
            try: offset += os.write(self.master, data[offset:offset+1024])
            except BlockingIOError: pass
            self.collect(.01)
            if time.monotonic() > end: raise AssertionError('PTY input stalled')
        self.collect()
    def wait(self, predicate, seconds=300, failure=None):
        """Polls until the predicate holds. A failure probe reads the saved session and
        returns the product's own error text once the awaited outcome can no longer arrive,
        so a provider refusal ends the wait in seconds instead of at the timeout."""
        end = time.monotonic()+seconds
        while time.monotonic() < end:
            self.collect()
            if predicate(): return
            if failure and (reason := failure()): raise AssertionError(f'Failed at {control["phase"]}: {reason}')
            if self.proc.poll() is not None: raise AssertionError('CLI exited')
        raise AssertionError('Timed out at '+control['phase'])
    def type(self, text): self.send('\x1b[200~'+text+'\x1b[201~')
    def line(self, text): self.type(text); self.send(b'\r')
    def image(self, path): self.send(b'\x0f'); self.send(json.dumps(str(path))); self.send(b'\r')
    def orderly_close(self, seconds=45):
        """Ctrl+D is the product's own shutdown path. Returns the exit code, or None when the
        host had to be terminated, which is a killed host and never an orderly restart."""
        self.send(b'\x04'); until = time.monotonic()+seconds
        while self.proc.poll() is None and time.monotonic() < until: self.collect(.1)
        code = self.proc.poll(); self.close(); return code
    def close(self):
        if self.proc.poll() is None:
            self.send(b'\x04'); until = time.monotonic()+15
            while self.proc.poll() is None and time.monotonic() < until: self.collect(.1)
            if self.proc.poll() is None:
                self.proc.terminate(); until = time.monotonic()+5
                while self.proc.poll() is None and time.monotonic() < until: self.collect(.1)
            if self.proc.poll() is None: self.proc.kill()
            self.proc.wait(timeout=5)
        try: os.close(self.master)
        except OSError: pass
def sessions():
    return {d['id']:(p,d) for p in state.glob('*/*/session.json') if (d:=json.loads(p.read_text()))}
def saved(id): return sessions()[id][1]
def events():
    p = observation/'native.jsonl'
    return [json.loads(line) for line in p.read_text().splitlines()] if p.exists() else []
def mcp_files():
    # Claude's preload writes mcp.jsonl; Grok's writes one file per startup phase.
    return {p.name: [json.loads(line) for line in p.read_text().splitlines()] for p in sorted(observation.glob('*mcp.jsonl'))}
def agent(id, name): return saved(id)['agents'][name]
def maintenance_failure(id, name):
    """Maintenance that ended in failed or cancelled, with the product's recorded reason."""
    done = agent(id, name).get('maintenance') or {}
    return f"maintenance {done['status']}: {done.get('detail') or 'no detail recorded'}" if done.get('status') in ('failed', 'cancelled') else None
def run_failure(id, name):
    """A turn that failed: the room marks the agent unavailable and stores the error text."""
    state = agent(id, name)
    return f"{name} failed: {state.get('error') or 'no error text recorded'}" if state.get('connection') == 'unavailable' or state.get('error') else None
def ready(id, names):
    found = sessions().get(id)
    return bool(found) and all(found[1]['agents'].get(n,{}).get('connection') == 'ready' for n in names)
def replies(id, name): return [m for m in saved(id)['messages'] if m['author'] == name]
def ask_all(t, id, names, text):
    before = {n: len(replies(id, n)) for n in names}; t.line(text)
    t.wait(lambda: all(len(replies(id, n)) > before[n] for n in names), 600, failure=lambda: next((r for n in names if (r := run_failure(id, n))), None))
    return {n: replies(id, n)[-1] for n in names}
def starts(name, session_id=None):
    found = [e for e in events() if e['boundary'] == 'start-completed' and 'tuple' in e and e.get('support',{}).get('provider') == name]
    return [e for e in found if session_id is None or e['tuple'].get('sessionId') == session_id]
def latest_support(name, session_id):
    found = [e for e in events() if e['boundary'] in ('start-completed','run-completed','maintain-completed') and e.get('support',{}).get('provider') == name and e['tuple'].get('sessionId') == session_id]
    return found[-1]['support'] if found else None
def require_image_support(id, name):
    support = latest_support(name, agent(id, name).get('sessionId'))
    assert support, f'Missing native observation for {name}'
    for path in ['initial', 'retrieval']:
        if not support[path]['available']: raise RuntimeError(f"{name} {path} unavailable: {support[path]['reason']}")
def native_delivery(id, name, digest):
    provider = agent(id, name)['sessionId']
    return provider, [e for e in events() if e['phase'] == control['phase'] and e['boundary'] == 'initial-native-request' and e.get('sessionId') == provider and any(i['sha256'] == digest for i in e.get('images', []))]
def stage(t, id, path):
    t.image(path); t.wait(lambda: len(saved(id).get('composerAttachments', [])) == 1)
    return saved(id)['composerAttachments'][0]
def message_for(id, attachment_id):
    return next(m for m in saved(id)['messages'] if any(a['id'] == attachment_id for a in m.get('attachments', [])))
def visual(t, id, name, index):
    """One newly sent image: private whole-field assertion plus its own native request."""
    require_image_support(id, name)
    metadata = stage(t, id, paths[index])
    response = ask_all(t, id, [name], f'@{name} '+whole_ask)[name]
    digest = sha(fixtures[index][0]); provider, native = native_delivery(id, name, digest)
    msg = message_for(id, metadata['id'])
    visual_passed = response['text'] == fixtures[index][1]
    native_passed = len(native) == 1 and len(native[0]['images']) == 1 and native[0]['associations'] == [f"Chittr image for message #{msg['id']}, attachment {metadata['id']}."]
    result = {'passed': visual_passed and native_passed, 'visualPassed': visual_passed, 'nativePassed': native_passed, 'roomSessionId': id, 'providerSessionId': provider, 'messageId': msg['id'], 'attachmentId': metadata['id'], 'sha256': digest, 'byteSize': len(fixtures[index][0]), 'attachmentOperationId': msg['attachmentOperation']['id'], 'nativeRequestId': native[0]['requestId'] if native else None}
    record[control['phase']] = result  # retained before asserting, so a failed run shows which half failed
    assert result['passed'], 'Visual assertion or correlated native delivery failed'
    return result
def stored_identity(id, attachment_id, data):
    """Public metadata in session.messages against the separately stored content identity."""
    metadata = next(a for a in message_for(id, attachment_id)['attachments'] if a['id'] == attachment_id)
    folder = sessions()[id][0].parent/'attachments'
    entry = json.loads((folder/'index.json').read_text())['attachments'][attachment_id]
    blob = folder/'blobs'/f"{entry['sha256']}.bin"
    return {'attachmentId': metadata['id'], 'filename': metadata['filename'], 'mediaType': metadata['mediaType'], 'byteSize': metadata['byteSize'], 'width': metadata['width'], 'height': metadata['height'],
        'indexSha256': entry['sha256'], 'blobSha256': sha(blob.read_bytes()) if blob.exists() else None, 'matchesSentContent': blob.exists() and sha(blob.read_bytes()) == sha(data) == entry['sha256'] and metadata['byteSize'] == len(data)}
def checkpoint_view(id, name, attachment_id=None, message_id=None):
    d = saved(id); points = d.get('checkpoints', []); last = points[-1] if points else None
    return {'agentCheckpointVersion': d['agents'][name].get('checkpointVersion'), 'latestVersion': last['version'] if last else None, 'count': len(points),
        'latestEntryCount': len(last['entries']) if last else 0,
        'latestReferencesAttachment': bool(last) and any((attachment_id and attachment_id in e['text']) or any(s['messageId'] == message_id for s in e['sources']) for e in last['entries'])}
def policy_view(name, session_id):
    found = starts(name, session_id)
    assert found, f'Missing startup observation for {name}'
    tuple_ = found[-1]['tuple']
    return {k: tuple_.get(k) for k in ['cliVersion','requestedModel','requestedEffort','observedModel','observedEffort','permissions','skillsEnabled','commandMode','commandModeSource']}
def lock():
    found = list(state.glob('*/room.lock'))
    return json.loads(found[0].read_text()) if found else None
def retrieval(t, id, name, index, fresh_session):
    """Post-maintenance retrieval: the private answer must arrive with a fresh authorized
    native image result, never from provider memory or replayed initial pixels. Discovery
    through read_conversation is recorded but not required here: a real checkpoint may name
    the older attachment, and the clean discovery-first proof is the fresh-retrieval row."""
    digest = sha(fixtures[index][0]); hidden = control['hiddenId']
    def results():
        found = [e for e in events() if e['boundary'] == 'dynamic-result' and e.get('name') == 'read_attachment' and any(i['sha256'] == digest for i in e.get('images', []))]
        for trace in mcp_files().values(): found += [e for e in trace if e['boundary'] == 'mcp-result' and e['name'] == 'read_attachment' and any(i['sha256'] == digest for i in e.get('images', []))]
        return found
    # The older image went to human only, so no native result for it may exist yet.
    assert not results(), 'The older image already had a native result before this retrieval'
    require_image_support(id, name)
    phase('retrieval')
    response = ask_all(t, id, [name], f'@{name} '+whole_ask.replace('Name the colors', 'Inspect the older saved visual reference in this room. Name the colors'))[name]
    visual_passed = response['text'] == fixtures[index][1]
    if name == 'codex':
        trace = [e for e in events() if e['phase'] == 'retrieval']
        discovery = next((i for i,e in enumerate(trace) if e['boundary'] == 'history-discovery' and any(d['attachmentId'] == hidden for d in e.get('discovered', []))), None)
        request = next((i for i,e in enumerate(trace) if e['boundary'] == 'dynamic-request' and e.get('attachmentId') == hidden), None)
        native_passed = request is not None and any(e['boundary'] == 'dynamic-result' and e.get('sessionId') == fresh_session and e.get('success') and any(i['sha256'] == digest for i in e.get('images', [])) for e in trace[request:])
        discovered = discovery is not None and request is not None and discovery < request
    else:
        native_passed = False; discovered = False
        for trace in mcp_files().values():
            discovery = next((i for i,e in enumerate(trace) if e['boundary'] == 'mcp-result' and e['name'] == 'read_conversation' and any(d['attachmentId'] == hidden for d in e.get('discovered', []))), None)
            request = next((i for i,e in enumerate(trace) if e['boundary'] == 'mcp-request' and e['name'] == 'read_attachment' and e['arguments']['attachment_id'] == hidden), None)
            if request is not None and any(e['boundary'] == 'mcp-result' and e['name'] == 'read_attachment' and e['roomSessionId'] == id and e['active'] and any(i['sha256'] == digest for i in e.get('images', [])) for e in trace[request:]):
                native_passed = True; discovered = discovered or (discovery is not None and discovery < request)
    replayed = any(e['boundary'] == 'initial-native-request' and e.get('images') for e in events() if e['phase'] == 'retrieval')
    result = {'passed': visual_passed and native_passed and not replayed, 'visualPassed': visual_passed, 'nativePassed': native_passed, 'discoveredThroughHistoryFirst': discovered, 'noNativeResultBeforeThisRetrieval': True, 'initialPixelsReplayed': replayed, 'roomSessionId': id, 'providerSessionId': agent(id, name)['sessionId'], 'attachmentId': hidden, 'sha256': digest, 'byteSize': len(fixtures[index][0])}
    record['retrieval'] = result  # retained before asserting, so a failed run shows which half failed
    assert result['passed'], 'Post-maintenance retrieval was not proved by a fresh native image result'
    return result
def seed_view(phase_name):
    seed = [e for e in events() if e['phase'] == phase_name and e['boundary'] == 'initial-native-request']
    return {'requests': len(seed), 'carriedImages': any(e.get('images') for e in seed), 'carriedPrivateAnswer': any(e.get('hasOracle') for e in seed), 'namedOlderAttachment': any(e.get('hasHiddenId') for e in seed)}
def summarizers(name, phase_name, exclude):
    ids = {e['tuple'].get('sessionId') for e in events() if e['phase'] == phase_name and e['boundary'] in ('start-completed','maintain-completed') and e.get('support',{}).get('provider') == name}
    return sorted(i for i in ids if i and i not in exclude)
def resume_turns(t, id, name):
    if agent(id, name).get('paused'): t.line(f'/continue @{name}'); t.wait(lambda: not agent(id, name).get('paused'))
    # Claude reports image support only after a real text turn establishes its model.
    if name == 'claude': ask_all(t, id, [name], '@claude Reply only to human with ready. This is a text-only model identity check.')
def compact(t, id, name):
    previous = agent(id, name)['sessionId']; version = agent(id, name).get('checkpointVersion') or 0
    t.line(f'/compact @{name}')
    t.wait(lambda: agent(id, name).get('sessionId') != previous and (agent(id, name).get('maintenance') or {}).get('status') == 'completed' and ready(id, [name]), 900, failure=lambda: maintenance_failure(id, name))
    return previous, version
def continuity(t, id, name):
    """Shared preparation: a first image in this provider session, then an older image
    addressed to human only, so its pixels and answer have never reached the provider."""
    resume_turns(t, id, name)
    phase('initial'); record['initial'] = visual(t, id, name, 0)
    # That reply is public history now, so maintenance may legitimately carry it. Only the
    # older image's answer and the unsent image's answer are still private from here on.
    control['oracles'] = [fixtures[1][1], fixtures[2][1]]
    phase('preparation'); metadata = stage(t, id, paths[1]); control['hiddenId'] = metadata['id']; phase('preparation')
    count = len(saved(id)['messages']); t.line('@human Saved visual reference.'); t.wait(lambda: len(saved(id)['messages']) == count+1)
    # Ordinary human-only notes: plain prose that neither quotes nor asks about any reply.
    notes = ['The morning build finished on the first try and the logs looked ordinary.',
             'Lunch is at noon today, and the afternoon meeting moved to the smaller room.',
             'The second-floor printer works again now that the paper jam has been cleared.']
    for i, note in enumerate(notes):
        t.line(f'@human Background note {i}. {note}'); t.wait(lambda: len(saved(id)['messages']) == count+i+2, 30)
    record['olderAttachmentBefore'] = stored_identity(id, metadata['id'], fixtures[1][0])
    assert record['olderAttachmentBefore']['matchesSentContent']
    return metadata
def after(t, id, name, metadata, previous, phase_name, session_prepared=False):
    fresh = agent(id, name)['sessionId']; older = message_for(id, metadata['id'])
    record['checkpointAfter'] = checkpoint_view(id, name, metadata['id'], older['id'])
    record['summarization'] = {'ran': (record['checkpointAfter']['latestVersion'] or 0) > (record['checkpointBefore']['latestVersion'] or 0), 'summarizerProviderSessions': summarizers(name, phase_name, {previous, fresh})}
    record['seed'] = seed_view(phase_name)
    assert not record['seed']['carriedImages'] and not record['seed']['carriedPrivateAnswer'], 'Maintenance replayed pixels or a private answer'
    if not session_prepared:
        resume_turns(t, id, name)
    record['retrieval'] = retrieval(t, id, name, 1, fresh)
    record['olderAttachmentAfter'] = stored_identity(id, metadata['id'], fixtures[1][0])
    assert record['olderAttachmentAfter'] == record['olderAttachmentBefore'], 'Public metadata or stored content changed'
    phase('later'); record['later'] = visual(t, id, name, 2)
t = None
try:
    t = Terminal(); t.wait(lambda: bool(sessions())); first = next(iter(sessions())); t.wait(lambda: ready(first, supported), 300)
    t.wait(lambda: not (termios.tcgetattr(t.master)[3] & termios.ICANON))
    if args.scenario == 'mixed':
        t.wait(lambda: agent(first, unsupported)['connection'] in ('ready', 'unavailable'), 300)
        everyone = supported+[unsupported]; addressed = ' '.join('@'+n for n in everyone)
        ask_all(t, first, supported, addressed+' Reply only to human with ready. This is a text-only check.')
        record['unsupported'] = {'agent': unsupported, 'connectionAtStart': agent(first, unsupported)['connection'], 'textBeforeRefusal': bool(replies(first, unsupported))}
        phase('initial')
        for name in supported: require_image_support(first, name)
        metadata = stage(t, first, paths[0])
        question = (f'The image has {3*len(supported)} equal vertical panels, numbered from 1 at the left. Each agent names only its own assigned panels, left to right: '
            + '; '.join(f'@{n} panels {3*i+1} to {3*i+3}' for i, n in enumerate(supported))
            + '. Use each exact color name from red, green, blue, yellow, cyan, purple, black, white as seen. Reply only to human with your comma-separated list, no spaces or explanation.')
        assert not any(a in question for a in answers.values())
        # Type the draft without sending it, and read the #68 status off the terminal.
        t.watch = ['Image status warning', '@'+unsupported]; count = len(saved(first)['messages'])
        t.type(addressed+' '+question); end = time.monotonic()+20
        while not t.seen and time.monotonic() < end: t.collect(.2)
        shown = t.seen and len(saved(first)['messages']) == count
        # 'Unsupported' when the connected adapter refuses images; 'Not observed' when the
        # recipient never connected, so the product could not reach that refusal at all.
        shown_status = next((label for label in ['Unsupported', 'Not observed'] if label in re.sub(r'\s+', ' ', t.recent)), None) if shown else None
        t.watch = None; t.recent = ''
        before = {n: len(replies(first, n)) for n in supported}; activities_before = sum(a['agent'] == unsupported for a in saved(first).get('activities', [])); t.send(b'\r')
        t.wait(lambda: all(len(replies(first, n)) > before[n] for n in supported), 900)
        msg = message_for(first, metadata['id']); digest = sha(fixtures[0][0]); record['recipients'] = {}
        association = f"Chittr image for message #{msg['id']}, attachment {metadata['id']}."
        for name in supported:
            provider, native = native_delivery(first, name, digest)
            # The first reply after the send answers the question; a later follow-up does not.
            visual_passed = replies(first, name)[before[name]]['text'] == answers[name]
            native_passed = len(native) == 1 and len(native[0]['images']) == 1 and native[0]['associations'] == [association]
            record['recipients'][name] = {'passed': visual_passed and native_passed, 'visualPassed': visual_passed, 'nativePassed': native_passed, 'roomSessionId': first, 'providerSessionId': provider, 'messageId': msg['id'], 'attachmentId': metadata['id'], 'sha256': digest, 'byteSize': len(fixtures[0][0]),
                'attachmentOperationId': msg['attachmentOperation']['id'], 'nativeRequestId': native[0]['requestId'] if native else None, 'delivery': msg['deliveries'].get(name, {}).get('status'), 'policy': policy_view(name, provider), 'support': latest_support(name, provider)}
        def refusal(): return message_for(first, metadata['id'])['deliveries'].get(unsupported, {})
        # dispatch() stamps an attemptId on every delivery it sends and charges in that same step,
        # so a refusal before dispatch or charge never carries one and starts no adapter run holding
        # the image message, after send and after retry. Total activity is context only.
        def activities(): return sum(a['agent'] == unsupported for a in saved(first).get('activities', []))
        def image_runs(): return sum(e['boundary'] == 'unsupported-run-started' and msg['id'] in e['messageIds'] for e in events())
        failed = refusal(); used = saved(first)['exchanges'][msg['id']]['used']; connected = agent(first, unsupported)['connection'] == 'ready'
        # Only a refused delivery can be retried; a never-scheduled one stays queued and is left alone.
        phase('retry'); retried = False
        if failed.get('status') == 'failed':
            notices = len(saved(first)['notices']); t.line(f"/retry #{msg['id']} @{unsupported}")
            t.wait(lambda: len(saved(first)['notices']) > notices and refusal().get('status') == 'failed', 120); retried = True
        activities_during = activities()-activities_before
        phase('text-continues'); count = len(replies(first, unsupported)); continued = False
        if connected:
            t.line(f'@{unsupported} Reply only to human with the single word continuing.')
            try: t.wait(lambda: len(replies(first, unsupported)) > count, 300); continued = True
            except AssertionError: continued = False
        # A recipient that cannot connect is a host blocker, recorded and never worked around.
        record['unsupported'].update({'statusShownBeforeSend': shown, 'shownStatus': shown_status, 'blocker': None if connected else agent(first, unsupported).get('error') or 'recipient unavailable', 'deliveryStatus': failed.get('status'), 'rationaleIsImageRefusal': failed.get('rationale', '').startswith('Image not delivered: '),
            'rationale': failed.get('rationale'), 'noticeRecorded': any(f"#{msg['id']}" in n['text'] and unsupported in n['text'] for n in saved(first)['notices']),
            'retryRefusedAgain': retried and refusal().get('status') == 'failed' and refusal().get('rationale') == failed.get('rationale'),
            'attemptIdAfterSend': failed.get('attemptId'), 'attemptIdAfterRetry': refusal().get('attemptId'), 'imageMessageDispatches': image_runs(), 'recipientActivitiesInWindow': activities_during,
            # Context only: shared with the other recipients' follow-ups, so not part of the pass rule.
            'sharedRootExchangeUsedAfterSend': used, 'sharedRootExchangeUsedAfterRetry': saved(first)['exchanges'][msg['id']]['used'], 'connectionAfterRefusal': agent(first, unsupported)['connection'], 'textAfterRefusal': continued})
        u = record['unsupported']
        u['passed'] = unsupported_passed(u)
        # Recorded, not asserted: a peer's public reply may reach a later dispatch, and by
        # construction it cannot equal this recipient's expected region answer.
        record['oracleIsolation'] = {'rule': 'disjoint panel regions with pairwise distinct answers; whole-field exact equality', 'answersPairwiseDistinct': len(set(answers.values())) == len(answers),
            'anyRegionAnswerInNativeRequest': any(e.get('hasOracle') for e in events() if e['phase'] == 'initial' and e['boundary'] == 'initial-native-request'), 'answersRetained': False}
        # Supported recipients stand on their own; an unproved unsupported path is named as such.
        record['status'] = 'failed' if not all(r['passed'] for r in record['recipients'].values()) else 'passed' if u['passed'] else 'supported-recipients-passed-unsupported-path-unproved'
    else:
        name = args.provider; metadata = continuity(t, first, name)
        record['policyBefore'] = policy_view(name, agent(first, name)['sessionId'])
        record['checkpointBefore'] = checkpoint_view(first, name)
        if args.scenario == 'compaction':
            phase('compaction'); previous, version = compact(t, first, name); done = agent(first, name)['maintenance']
            record['maintenance'] = {'operation': '/compact @'+name, 'route': done['route'], 'purpose': done.get('purpose'), 'status': done['status'], 'nativeCompaction': starts(name)[-1]['tuple'].get('nativeCompaction'),
                'previousProviderSessionId': previous, 'providerSessionId': agent(first, name)['sessionId'], 'checkpointVersionBefore': version, 'checkpointVersionAfter': agent(first, name).get('checkpointVersion')}
            after(t, first, name, metadata, previous, 'compaction')
        else:
            phase('restart'); previous = agent(first, name)['sessionId']
            assert not agent(first, name).get('active') and (agent(first, name).get('maintenance') or {}).get('status') not in ('requested','waiting','running'), 'Restart must begin idle'
            held = lock(); pid = t.proc.pid; code = t.orderly_close(); t = None; released = lock() is None
            record['restart'] = {'previousHostPid': pid, 'lockHeldByPreviousHost': bool(held) and held['pid'] == pid, 'orderlyExitCode': code, 'lockReleased': released, 'killedHostOrStaleLock': code is None or not released}
            assert code == 0 and released and record['restart']['lockHeldByPreviousHost'], 'Host did not shut down in order and release the workspace lock'
            # A saved ready flag is not a new startup: wait for this host's own native start,
            # and for any recovery replacement it began to finish.
            t = Terminal(first); t.wait(lambda: ready(first, [name]) and any(e['phase'] == 'restart' and e['boundary'] == 'start-completed' for e in events()) and (agent(first, name).get('maintenance') or {}).get('status') not in ('requested','waiting','running','failed','cancelled'), 900,
                failure=lambda: maintenance_failure(first, name) or (f"{name} failed: {agent(first, name)['error']}" if agent(first, name).get('error') else None))
            held = lock(); fresh = agent(first, name)['sessionId']; recovered = agent(first, name).get('maintenance') or {}
            record['restart'].update({'hostPid': t.proc.pid, 'processIdentityChanged': t.proc.pid != pid, 'lockReacquiredByNewHost': bool(held) and held['pid'] == t.proc.pid, 'previousProviderSessionId': previous, 'providerSessionId': fresh,
                'outcome': 'resumed native state' if fresh == previous else 'recovery replacement session', 'recoveryMaintenance': {k: recovered.get(k) for k in ['route','purpose','status','checkpointVersion']} if fresh != previous else None})
            assert record['restart']['processIdentityChanged'] and record['restart']['lockReacquiredByNewHost']
            record['policyAfter'] = policy_view(name, fresh)
            effective = ['permissions','skillsEnabled','commandMode','commandModeSource','requestedModel','requestedEffort','cliVersion']
            record['restart']['effectivePolicyUnchanged'] = all(record['policyBefore'][k] == record['policyAfter'][k] for k in effective)
            assert record['restart']['effectivePolicyUnchanged'], 'Effective policy or build changed across the restart'
            resume_turns(t, first, name); support = latest_support(name, agent(first, name)['sessionId'])
            record['restart']['imageSupportAfterRestart'] = {p: support[p] for p in ['initial','retrieval']}
            session_prepared = True
            if not support['initial']['available'] or not support['retrieval']['available']:
                # A resumed session that refuses images is recorded as such. The supported
                # product route to a fresh session is then taken and named; nothing is forced.
                previous, version = compact(t, first, name)
                record['restart']['followingRoute'] = {'operation': '/compact @'+name, 'route': agent(first, name)['maintenance']['route'], 'reason': support['initial'].get('reason') or support['retrieval'].get('reason'), 'providerSessionId': agent(first, name)['sessionId']}
                session_prepared = False
            after(t, first, name, metadata, previous, 'restart', session_prepared=session_prepared)
        record['status'] = 'passed'
except Exception as error:
    record['status'] = 'failed'; record['failureType'] = type(error).__name__; record['phase'] = control['phase']
    raise
finally:
    if t:
        try: t.close()
        except Exception: t.proc.kill(); t.proc.wait(timeout=5)
    record['completedAt'] = datetime.now(timezone.utc).isoformat()
    record['nativeEvents'] = events(); record['mcpEvents'] = mcp_files(); record['privateAnswersRetained'] = False
    text = json.dumps(record, indent=2)+'\n'
    # Computed, not declared: no private answer, scratch path or image bytes may be retained.
    leaked = any(o in text for o in oracles) or str(root) in text or 'iVBOR' in text
    if leaked: text = json.dumps({'issue': 57, 'scenario': args.scenario, 'status': 'failed', 'failureType': 'EvidenceNotSanitized'}, indent=2)+'\n'
    pathlib.Path(args.output).write_text(text)
    shutil.rmtree(root)
    assert not leaked, 'Evidence held a private answer, scratch path or image bytes and was withheld'
print('PASS' if record['status'] == 'passed' else 'BLOCKED', f"#57 {args.scenario} built-CLI PTY acceptance: {record['status']}")
if record['status'] != 'passed': raise SystemExit(1)
