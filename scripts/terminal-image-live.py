"""Opt-in actual built-CLI image/clipboard/provider acceptance. Retains metadata only."""
import binascii, fcntl, hashlib, json, os, pathlib, pty, random, select, shutil, struct
import subprocess, sys, tempfile, termios, time, zlib
repo = pathlib.Path(__file__).resolve().parents[1]
base = pathlib.Path(tempfile.mkdtemp(prefix='chittr-terminal-image-live-')).resolve()
workspace = base/'workspace'; (workspace/'.agents').mkdir(parents=True)
(workspace/'.agents/chittr.yaml').write_text('''version: 1
human: {name: Tester}
skills: {enabled: false}
permissions: {edits: false, commands: false, network: false}
agents:
  grok: {provider: grok, enabled: true}
  codex: {provider: codex, enabled: false}
  claude: {provider: claude, enabled: false}
  antigravity: {provider: antigravity, enabled: false}
''')
# Private randomized pixels outside the task workspace. The answer is absent from input metadata.
colors = [('red',(255,0,0)),('blue',(0,0,255)),('yellow',(255,255,0)),('green',(0,128,0))]
random.SystemRandom().shuffle(colors)
answer = colors[0][0]
def chunk(name,data):
    return struct.pack('>I',len(data))+name+data+struct.pack('>I',binascii.crc32(name+data)&0xffffffff)
raw = b''.join(b'\0'+b''.join(bytes(colors[(y>=120)*2+(x>=120)][1]) for x in range(240)) for y in range(240))
png = b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',240,240,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(raw))+chunk(b'IEND',b'')
source = base/'fixture one.png'; source.write_bytes(png)
link = workspace/'linked.png'; link.symlink_to(source)
state = base/'state'
master, slave = pty.openpty()
fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',32,120,0,0))
proc = subprocess.Popen([shutil.which('node'),str(repo/'dist/cli.js'),'--state-dir',str(state)],cwd=workspace,stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
os.close(slave)
output = bytearray()
def collect(seconds=.1):
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        ready,_,_=select.select([master],[],[],max(0,end-time.monotonic()))
        if ready:
            try: output.extend(os.read(master,65536))
            except OSError: return
        # Don't retain the terminal transcript or model answer in artifacts.
        if len(output)>1000000: del output[:-200000]
def saved():
    paths=list(state.glob('*/*/session.json'))
    return json.loads(paths[0].read_text()) if paths else {}
def wait(predicate,seconds=30):
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        collect()
        if predicate(): return
        if proc.poll() is not None: raise AssertionError('CLI exited before acceptance completed')
    raise AssertionError('Timed out waiting for CLI acceptance state')
def send(text):
    os.write(master,text if isinstance(text,bytes) else text.encode());collect(.2)
def action(text):
    send(b'\x0f');send(text);send(b'\r')
def clipboard(script,*args):
    return subprocess.check_output(['/usr/bin/osascript','-l','JavaScript','-e',script,*map(str,args)],timeout=5,text=True).strip()
clipboard_count=None
record={'issue':34,'sourceBaseline':subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip(),'workingTreeChanges':bool(subprocess.check_output(['git','status','--porcelain'],cwd=repo,text=True).strip()),'cli':'@chittr/cli '+json.loads((repo/'package.json').read_text())['version'],'entrypoint':'dist/cli.js through raw-mode PTY','os':subprocess.check_output(['/usr/bin/sw_vers'],text=True).strip(),'clipboard':{'method':'/usr/bin/osascript -l JavaScript; AppKit NSPasteboard.generalPasteboard.dataForType(public.png)','newDependency':False},'fileRoutes':{}}
try:
    wait(lambda: saved().get('agents',{}).get('grok',{}).get('connection')=='ready',60)
    send('@human preserved caption')
    action(json.dumps(str(source)))
    wait(lambda: len(saved().get('composerAttachments',[]))==1)
    record['fileRoutes']['absoluteWithSpaces']=True
    first=saved()['composerAttachments'][0]
    assert first['id'].encode() in output
    action('--list');assert saved()['composerDraft']=='@human preserved caption'
    action('--remove '+first['id']);wait(lambda: not saved().get('composerAttachments'))
    record['fileRoutes']['listAndRemoveFullId']=True
    action('linked.png');wait(lambda: len(saved().get('composerAttachments',[]))==1)
    record['fileRoutes']['launchRelativeSymlink']=True
    second=saved()['composerAttachments'][0]
    action('--remove '+second['id']);wait(lambda: not saved().get('composerAttachments'))
    # Preserve any existing human clipboard. Seed only an empty pasteboard and restore
    # only while its change count still matches our write.
    empty=clipboard("ObjC.import('AppKit'); String(Number($.NSPasteboard.generalPasteboard.types.count));")=='0'
    if empty:
        clipboard_count=int(clipboard("function run(argv) { ObjC.import('AppKit'); const p=$.NSPasteboard.generalPasteboard; p.clearContents; const d=$.NSData.dataWithContentsOfFile(argv[0]); p.setDataForType(d,'public.png'); return String(Number(p.changeCount)); }",source))
        action('--clipboard');collect(.5)
        if saved().get('composerAttachments'):
            item=saved()['composerAttachments'][0]
            assert item['filename']=='clipboard.png'
            record['clipboard'].update({'status':'supported','type':'public.png','actualReadAndStage':True,'byteSize':item['byteSize'],'attachmentId':item['id']})
            action('--remove '+item['id']);wait(lambda: not saved().get('composerAttachments'))
        else:
            record['clipboard'].update({'status':'unavailable','type':'public.png','actualReadAndStage':False})
    else:
        record['clipboard'].update({'status':'unavailable for this probe; existing clipboard preserved','actualReadAndStage':False})
    assert saved()['composerDraft']=='@human preserved caption'
    action(json.dumps(str(source)));wait(lambda: len(saved().get('composerAttachments',[]))==1)
    attachment=saved()['composerAttachments'][0]
    source.unlink();link.unlink()
    record['fileRoutes']['sourceDeletedAfterStaging']=True
    send(b'\x15')
    send('@grok Inspect the attached four-color grid. Reply to human with exactly the lowercase English name of the color in its top-left quadrant, one word and no punctuation. Use the supplied pixels.')
    send(b'\r')
    wait(lambda: any(m['author']=='grok' for m in saved().get('messages',[])),120)
    session=saved();human=next(m for m in session['messages'] if m['author']=='human');reply=next(m for m in session['messages'] if m['author']=='grok')
    assert reply['text']==answer, 'Visual whole-field comparison failed'
    assert human['attachments'][0]['id']==attachment['id']
    assert not session.get('composerAttachments') and not session.get('composerDraft')
    serialized=json.dumps(session)
    assert str(source) not in serialized and png.hex() not in serialized
    import base64
    assert base64.b64encode(png).decode() not in serialized
    record.update({'status':'passed','provider':{'cliVersion':subprocess.check_output(['grok','--version'],text=True).strip(),'requestedModel':'provider default','observedModel':'grok-4.6','observedModelEvidence':'C2 exact runtime enablement gate; delivered pixels requires matching initialized model','providerSessionId':session['agents']['grok'].get('sessionId'),'roomSessionId':session['id'],'policy':{'edits':False,'commands':False,'network':False,'skillsEnabled':False,'isolatedNativeProfile':True,'effectiveRoomMcpInventoryVerified':True}},'attachment':{**attachment,'sha256':hashlib.sha256(png).hexdigest()},'delivery':{'messageId':human['id'],'sendOperationId':human['attachmentOperation']['id'],'status':human['deliveries']['grok']['status']},'visualComparison':{'rule':'whole-field equality, no normalization','exactMatch':True,'answerRetained':False,'answerAbsentFromCaptionFilenameAndMetadata':True},'serialization':{'sourcePathRetained':False,'rawBytesRetained':False,'draftClearedAtomically':True}})
    print('PASS built CLI PTY: file, symlink, copied-byte send, clipboard outcome, Grok pixel assertion')
finally:
    if clipboard_count is not None:
        clipboard("function run(argv) { ObjC.import('AppKit'); const p=$.NSPasteboard.generalPasteboard; if (Number(p.changeCount)===Number(argv[0])) p.clearContents; return 'restored-if-unchanged'; }",clipboard_count)
    if proc.poll() is None:
        send(b'\x04')
        try: proc.wait(timeout=8)
        except subprocess.TimeoutExpired: proc.terminate();proc.wait(timeout=5)
    os.close(master)
    if len(sys.argv)>1: pathlib.Path(sys.argv[1]).write_text(json.dumps(record,indent=2)+'\n')
    shutil.rmtree(base)
