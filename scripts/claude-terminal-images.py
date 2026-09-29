"""Opt-in #53 acceptance via actual raw-mode dist/cli.js. No transcript retained."""
import argparse, binascii, fcntl, hashlib, json, os, pathlib, pty, random, select
import shutil, struct, subprocess, tempfile, termios, time, zlib
parser = argparse.ArgumentParser()
parser.add_argument('--room', choices=['restricted', 'trusted'], required=True)
parser.add_argument('--trusted-commands', action='store_true')
parser.add_argument('--output', required=True)
parser.add_argument('--evidence-issue', type=int, choices=[57], help='Stamp a #57 integrated-build rerun; the default stamp is this provider ticket')
args = parser.parse_args()
assert args.trusted_commands == (args.room == 'trusted'), 'Trusted coverage requires an explicit command grant'
repo = pathlib.Path(__file__).resolve().parents[1]
root = pathlib.Path(tempfile.mkdtemp(prefix='claude-terminal-images-', dir='/private/tmp'))
workspace = root/'workspace'; (workspace/'.agents').mkdir(parents=True)
state = root/'state'; observation = root/'observation'; observation.mkdir()
granted = args.room == 'trusted'; value = str(granted).lower()
(workspace/'.agents/chittr.yaml').write_text(f'''version: 1
human: {{name: Tester}}
skills: {{enabled: {value}}}
permissions: {{edits: {value}, commands: {value}, network: {value}}}
agents:
  claude: {{provider: claude, enabled: true, model: opus, effort: xhigh}}
  codex: {{provider: codex, enabled: false}}
  grok: {{provider: grok, enabled: false}}
  antigravity: {{provider: antigravity, enabled: false}}
''')
colors = [('red',(255,0,0)),('green',(0,160,0)),('blue',(0,0,255)),('yellow',(255,255,0)),('cyan',(0,255,255)),('purple',(128,0,128)),('black',(0,0,0)),('white',(255,255,255))]
def chunk(name, data):
    return struct.pack('>I',len(data))+name+data+struct.pack('>I',binascii.crc32(name+data)&0xffffffff)
def make_image():
    palette = colors[:]; random.SystemRandom().shuffle(palette)
    raw = b''.join(b'\0'+b''.join(bytes(palette[x//80][1]) for x in range(640)) for _ in range(160))
    png = b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',640,160,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(raw))+chunk(b'IEND',b'')
    return png, ','.join(c[0] for c in palette)
fixtures = [make_image() for _ in range(3)]
paths = []
for i,(png,_) in enumerate(fixtures):
    path=root/f'image-{i}.png'; path.write_bytes(png); paths.append(path)
control={'phase':'warmup','hiddenId':'','oracles':[f[1] for f in fixtures]}
def phase(name):
    control['phase']=name
    temporary=observation/'private-control.tmp'; temporary.write_text(json.dumps(control)); temporary.replace(observation/'private-control.json')
phase('warmup')
command=[shutil.which('node'),'--import',str(repo/'scripts/claude-terminal-observer.mjs'),str(repo/'dist/cli.js'),'--state-dir',str(state)]
if granted: command.append('--trusted-commands')
record={'issue':args.evidence_issue or 53,'entryPoint':'built dist/cli.js raw-mode PTY','room':args.room,'requestedModel':'opus','requestedEffort':'xhigh','source':{'commit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip(),'patchSha256':hashlib.sha256(subprocess.check_output(['git','diff','--binary','HEAD'],cwd=repo)).hexdigest()},'freshRoute':'saved-room fresh start after checkpoint-seed rejection in controller run','status':'pending'}
class Terminal:
    def __init__(self, session=None):
        self.master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',32,120,0,0))
        env=dict(os.environ);env['CHITTR_IMAGE_OBSERVATION']=str(observation)
        self.proc=subprocess.Popen(command+(['--session',session] if session else []),cwd=workspace,env=env,stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
        os.close(slave);os.set_blocking(self.master,False)
    def collect(self, seconds=.05):
        end=time.monotonic()+seconds
        while time.monotonic()<end:
            ready,_,_=select.select([self.master],[],[],max(0,end-time.monotonic()))
            if ready:
                try: os.read(self.master,65536) # deliberately discard all terminal text
                except OSError: return
    def send(self, value):
        data=value if isinstance(value,bytes) else value.encode()
        offset=0;end=time.monotonic()+30
        while offset<len(data):
            try: offset+=os.write(self.master,data[offset:offset+1024])
            except BlockingIOError: pass
            self.collect(.01)
            if time.monotonic()>end: raise AssertionError('PTY input stalled')
        self.collect()
    def wait(self, predicate, seconds=180):
        end=time.monotonic()+seconds
        while time.monotonic()<end:
            self.collect()
            if predicate(): return
            if self.proc.poll() is not None: raise AssertionError('CLI exited')
        raise AssertionError('Timed out at '+control['phase'])
    def line(self,text): self.send('\x1b[200~'+text+'\x1b[201~');self.send(b'\r')
    def image(self,path): self.send(b'\x0f');self.send(json.dumps(str(path)));self.send(b'\r')
    def close(self):
        if self.proc.poll() is None:
            self.send(b'\x04')
            until=time.monotonic()+15
            while self.proc.poll() is None and time.monotonic()<until: self.collect(.1)
            if self.proc.poll() is None:
                self.proc.terminate()
                until=time.monotonic()+5
                while self.proc.poll() is None and time.monotonic()<until:self.collect(.1)
            if self.proc.poll() is None:self.proc.kill()
            self.proc.wait(timeout=5)
        os.close(self.master)
def sessions():
    return {d['id']:(p,d) for p in state.glob('*/*/session.json') if (d:=json.loads(p.read_text()))}
def events(name='native'):
    p=observation/(name+'.jsonl')
    return [json.loads(line)for line in p.read_text().splitlines()] if p.exists() else []
def ready(id): return sessions().get(id,(None,{}))[1].get('agents',{}).get('claude',{}).get('connection')=='ready'
def reply_count(id):return sum(m['author']=='claude'for m in sessions()[id][1]['messages'])
ask='@claude Name the colors of the eight vertical panels from left to right. Use each exact color name from red, green, blue, yellow, cyan, purple, black, white as seen. Reply only to human with a comma-separated list, no spaces or explanation.'
def answer(t,id,prompt):
    count=reply_count(id);t.line(prompt);t.wait(lambda:reply_count(id)>count)
    return next(m for m in reversed(sessions()[id][1]['messages'])if m['author']=='claude')
def visual(t,id,index):
    t.image(paths[index]);t.wait(lambda:len(sessions()[id][1].get('composerAttachments',[]))==1)
    metadata=sessions()[id][1]['composerAttachments'][0]
    response=answer(t,id,ask)
    assert response['text']==fixtures[index][1], 'Whole-field visual assertion failed'
    d=sessions()[id][1];provider=d['agents']['claude']['sessionId'];sha=hashlib.sha256(fixtures[index][0]).hexdigest()
    native=[e for e in events() if e['phase']==control['phase'] and e['boundary']=='initial-native-request' and e['sessionId']==provider and any(i['sha256']==sha for i in e['images'])]
    assert len(native)==1,'Missing correlated native delivery'
    msg=next(m for m in d['messages']if any(a['id']==metadata['id']for a in m.get('attachments',[])))
    return {'passed':True,'roomSessionId':id,'providerSessionId':provider,'messageId':msg['id'],'attachmentId':metadata['id'],'sha256':sha,'byteSize':len(fixtures[index][0]),'nativeRequestId':native[0]['requestId']}
t=None
try:
    t=Terminal();t.wait(lambda:bool(sessions()));first=next(iter(sessions()));t.wait(lambda:ready(first))
    answer(t,first,'@claude Reply only to human with ready. This is a text-only model identity check.')
    phase('initial');record['initial']=visual(t,first,0)
    phase('later');record['later']=visual(t,first,1)
    assert record['initial']['providerSessionId']==record['later']['providerSessionId']
    t.close();t=None
    phase('preparation');before=set(sessions());t=Terminal();t.wait(lambda:bool(set(sessions())-before));historical=next(iter(set(sessions())-before));t.wait(lambda:ready(historical))
    t.image(paths[2]);t.wait(lambda:len(sessions()[historical][1].get('composerAttachments',[]))==1)
    control['hiddenId']=sessions()[historical][1]['composerAttachments'][0]['id'];phase('preparation')
    t.line('@human Saved visual reference.');t.wait(lambda:len(sessions()[historical][1]['messages'])==1)
    for i in range(220):
        t.line('@human '+f'Background note {i}. '+'No pending task. '*70)
        t.wait(lambda:len(sessions()[historical][1]['messages'])==i+2,10)
    previous=sessions()[historical][1]['agents']['claude']['sessionId'];t.close();t=None
    path,saved=sessions()[historical];last=saved['messages'][-1]
    saved['checkpoints']=[{'version':1,'createdAt':last['createdAt'],'sourceAgent':'claude','through':last['sequence'],'messageId':last['id'],'entries':[{'category':'objective','text':'The later background notes have no pending task.','sources':[{'messageId':last['id'],'author':'human'}]}]}]
    saved['agents']['claude'].pop('sessionId',None);saved['agents']['claude']['contextThrough']=0
    path.write_text(json.dumps(saved));phase('fresh-seed')
    t=Terminal(historical);t.wait(lambda:ready(historical) and any(e['phase']=='fresh-seed' and e['boundary']=='start-completed' and e['tuple'].get('sessionId')!=previous for e in events()) and not (termios.tcgetattr(t.master)[3] & termios.ICANON));assert sessions()[historical][1]['checkpoints']==saved['checkpoints']
    answer(t,historical,'@claude Reply to human with ready. Do not inspect images yet.')
    fresh=sessions()[historical][1]['agents']['claude']['sessionId'];assert fresh!=previous
    seed=[e for e in events()if e['phase']=='fresh-seed' and e['boundary']=='initial-native-request']
    assert seed and all(not e['hasHiddenId']and not e['hasOracle']and not e['images']and e['frameBytes']<131072 for e in seed)
    phase('retrieval');response=answer(t,historical,ask.replace('Name the colors','Inspect the older saved visual reference in this room. Name the colors'))
    assert response['text']==fixtures[2][1], 'Fresh retrieval private visual assertion failed'
    sha=hashlib.sha256(fixtures[2][0]).hexdigest();trace=events('mcp')
    discovery=next(i for i,e in enumerate(trace)if e['boundary']=='mcp-result'and e['name']=='read_conversation'and any(d['attachmentId']==control['hiddenId']for d in e['discovered']))
    retrieval=next(i for i,e in enumerate(trace)if e['boundary']=='mcp-request'and e['name']=='read_attachment'and e['arguments']['attachment_id']==control['hiddenId'])
    assert discovery<retrieval
    assert any(e['boundary']=='mcp-result'and e['name']=='read_attachment'and e['roomSessionId']==historical and e['active']and any(i['sha256']==sha for i in e['images'])for e in trace)
    assert not any(e['boundary']=='initial-native-request'and e['images']for e in events()if e['phase']in ['fresh-seed','retrieval'])
    assert any(e['boundary']=='native-user-replay'and e['sessionId']==fresh and any(i['sha256']==sha for i in e['images'])for e in events())
    record['retrieval']={'passed':True,'roomSessionId':historical,'previousProviderSessionId':previous,'providerSessionId':fresh,'attachmentId':control['hiddenId'],'sha256':sha,'byteSize':len(fixtures[2][0]),'checkpointRoundTripPassed':True,'seedChecksPassed':True}
    record['status']='passed'
except Exception as error:
    record['status']='failed';record['failureType']=type(error).__name__;record['phase']=control['phase']
    raise
finally:
    if t:
        try:t.close()
        except Exception: t.proc.kill();t.proc.wait(timeout=5)
    record['nativeEvents']=events();record['mcpEvents']=events('mcp');record['privateAnswersRetained']=False
    pathlib.Path(args.output).write_text(json.dumps(record,indent=2)+'\n')
    shutil.rmtree(root)
print('PASS Claude built-CLI PTY first, later and fresh historical retrieval')
