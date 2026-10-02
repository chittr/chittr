"""Drive the real raw-mode terminal UI through a PTY, using deterministic peers."""
import fcntl, json, os, pathlib, pty, re, select, shutil, struct, subprocess, tempfile, termios, time
repo = pathlib.Path(__file__).resolve().parents[1]
base = pathlib.Path(tempfile.mkdtemp(prefix='chittr-terminal-')).resolve()
workspace = base / 'project' / 'nested'; workspace.mkdir(parents=True)
(workspace / 'explorer fixtures' / 'empty').mkdir(parents=True)
(workspace / 'explorer fixtures' / 'note one.md').write_text('A note')
(workspace / 'explorer fixtures' / 'note two.md').write_text('Another note')
(workspace / 'docs').mkdir()
(workspace / 'docs' / 'roadmap.md').write_text('A roadmap')
master, slave = pty.openpty()
height = 28
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', height, 96, 0, 0))
proc = subprocess.Popen([shutil.which('node'), '--import', str(repo / 'node_modules/tsx/dist/loader.mjs'), str(repo / 'scripts/tui-fixture.ts'), str(base / 'state')], cwd=workspace, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)
output = bytearray()
def collect(seconds=0.12):
    until=time.monotonic()+seconds
    while time.monotonic()<until:
        ready,_,_=select.select([master],[],[],min(0.04,max(0,until-time.monotonic())))
        if ready:
            try: output.extend(os.read(master, 65536))
            except OSError: return

def send(data): os.write(master,data); collect()
def state():
    paths=list((base/'state').glob('*/*/session.json'))
    assert len(paths)==1, 'Fixture must save exactly one session'
    return json.loads(paths[0].read_text())
def expect_draft(text):
    deadline=time.monotonic()+2
    while state().get('composerDraft', '')!=text and time.monotonic()<deadline:
        collect(0.05)
    assert state().get('composerDraft', '')==text, repr(state().get('composerDraft', ''))
def frame_bytes():
    # A PTY read may end midway through a paint. Each complete row ends in EL;
    # retain the preceding full frame until all fixed-height rows have arrived.
    for frame in reversed(bytes(output).split(b'\x1b[?25l\x1b[H')[1:]):
        if frame.count(b'\x1b[K')==height:
            return frame[:frame.rfind(b'\x1b[K')+3]
    return b''
def frame_lines():
    frame=frame_bytes().decode(errors='replace')
    return [re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', line).rstrip('\r') for line in frame.split('\r\n')]
def history_start():
    return '\n'.join(frame_lines()[3:8])
def mouse(button, x, y, release=False):
    send(f'\x1b[<{button};{x+1};{y+1}{"m" if release else "M"}'.encode())
def clipboard(): return (base/'state'/'clipboard.txt').read_text()
try:
    collect(0.8)
    # Under concurrent browser-test load, wait for a complete initial frame.
    ready_by=time.monotonic()+3
    while 'Bill McGlone ›' not in '\n'.join(frame_lines()) and time.monotonic()<ready_by:
        collect(0.1)
    assert b'CHITTR' in output, bytes(output)[-1500:]
    assert 'Bill McGlone ›' in '\n'.join(frame_lines()), 'Composer must show the configured name'
    assert any(line.startswith('Bill McGlone  #m') for line in frame_lines()), 'Transcript must show the configured name'
    assert b'\x1b[?1002h' in output and b'\x1b[?1006h' in output
    send(b'\x1b[B')
    expect_draft('')
    send(b'\x1b[A')
    expect_draft('@human History marker 29')
    send(b'\x1b[A')
    expect_draft('@human History marker 28')
    send(b'\x1b[B')
    expect_draft('@human History marker 29')
    send(b'\x1b[B\x1b[B')
    expect_draft('')
    send(b'Unsent draft\x1b[A')
    expect_draft('@human History marker 29')
    send(b'\x1b[B')
    expect_draft('Unsent draft')
    send(b'\x15')
    latest=history_start()
    send(b'\x1b[<64;20;10M')
    assert history_start()!=latest, 'Wheel up did not scroll the transcript'
    assert any('lines below' in line for line in frame_lines())
    send(b'\x1b[<65;20;10M')
    assert history_start()==latest, 'Wheel down did not return to the latest messages'
    send(b'\x1b[<64;20;10M'*50)
    assert '#m1' in history_start(), 'The first conversation message is unreachable'
    send(b'\x1b[<64;20;10M')
    assert '#m1' in history_start(), 'Scrolling above the start should clamp'
    row=next((i for i,line in enumerate(frame_lines()) if line=='  History marker 00'),None)
    assert row is not None, repr(frame_lines())
    mouse(0,2,row); mouse(32,8,row)
    assert b'\x1b[30;103mHistory\x1b[0m' in frame_bytes(), 'Dragging must visibly highlight the selected text'
    mouse(0,8,row,True)
    assert clipboard()=='History', 'Mouse release should copy the selected text'
    assert 'Copied to clipboard' in '\n'.join(frame_lines())
    send(b'\x03')
    assert state()['paused'] is False, 'Copying a selection must not stop the room'
    send(b'\x16')
    collect(0.3)
    assert state()['composerDraft']=='History', 'Ctrl+V must paste copied text into the draft'
    assert len(state()['messages'])==30, 'Clipboard paste must not send'
    send(b'\x15')
    mouse(0,2,row); mouse(0,2,row,True)
    assert clipboard()=='History', 'A click without a selection must not erase the clipboard'
    failure=base/'state'/'clipboard-failure'; failure.touch()
    mouse(0,2,row); mouse(32,18,row); mouse(0,18,row,True)
    assert 'Copy failed:' in '\n'.join(frame_lines())
    assert clipboard()=='History'
    failure.unlink(); send(b'\x03')
    assert clipboard()=='History marker 00', 'Copy failure should allow a retry'
    oldest=history_start(); send(b'\x1b')
    assert history_start()==oldest, 'Clearing selection must keep the reading position'
    failure.touch(); send(b'\x16')
    assert 'Paste failed:' in '\n'.join(frame_lines())
    assert state()['composerDraft']==''
    failure.unlink()
    send(b'@\t')
    assert 'Bill McGlone (@human)' in '\n'.join(frame_lines()), 'Recipient completion should label the human by name'
    oldest=history_start()
    send(b'\x1b')
    assert history_start()==oldest, 'Dismissing completions should keep the reading position'
    send(b'\x15')
    send(b'\x1b')
    assert history_start()==latest, 'Escape did not jump to the latest messages'
    assert not any('lines below' in line for line in frame_lines())
    send(b'\x1b[?1u')  # Simulated enhanced-keyboard capability response.
    send(b'@cod\tFirst\nSecond\x1b[13;5uThird\r')
    assert state()['messages'][-1]['text']=='First\nSecond\nThird'
    send(b'@human abc\x1b[D\x1b[D')
    send(b'\x1b[5~')
    keyboard_position=history_start()
    send(b'\x1b[<64;20;10M')
    assert history_start()!=keyboard_position
    anchored=history_start()
    collect(1.3)
    assert history_start()==anchored, 'Streaming output moved the history reading position'
    send(b'\x1b[<0;20;10M\x1b[<0;20;10m')
    send(b'X')
    send(b'\x1b[200~P\nQ\x1b[201~')
    collect(0.3)
    assert state()['composerDraft']=='@human aXP\nQbc', state()['composerDraft']
    assert len(state()['messages'])==32, 'Pasted newline submitted the draft'
    send(b'\r')
    assert state()['messages'][-1]['text']=='aXP\nQbc', 'Incoming text moved the draft cursor'
    send(b'\x1b[A')
    expect_draft('@human aXP\nQbc')
    send(b'\x1b[A')
    expect_draft('@codex First\nSecond\nThird')
    send(b'\x1b[B')
    expect_draft('@human aXP\nQbc')
    send(b'\x1b[B\x1b[B')
    expect_draft('')
    assert history_start()==anchored, 'Sending a message forced history to the bottom'
    send(b'\x1b')
    assert not any('lines below' in line for line in frame_lines())
    send(b'@human Inspect sam\t\r')
    assert state()['messages'][-1]['text']=='Inspect `sample.txt`'
    # ./ opens immediately, folders stay open, and selecting a file does not send.
    before_files=len(state()['messages'])
    send(b'@human Inspect ./expl')
    assert 'File explorer' in '\n'.join(frame_lines()), 'Typing ./ must open the file explorer without Tab'
    expect_draft('@human Inspect ./expl')
    send(b'\r')
    expect_draft('@human Inspect "./explorer fixtures/')
    send(b'\r')
    expect_draft('@human Inspect "./explorer fixtures/empty/')
    assert 'No matching files or folders.' in '\n'.join(frame_lines())
    send(b'\r')
    assert len(state()['messages'])==before_files, 'Enter in an empty folder must not send'
    send(b'\x1b[D\x1b[B\t')
    expect_draft('@human Inspect `./explorer fixtures/note one.md` ')
    assert len(state()['messages'])==before_files, 'Selecting a file must not send'
    assert 'File explorer' not in '\n'.join(frame_lines())
    send(b'\x15@human Inspect "./explorer fixtures/note tw')
    assert any('note two.md' in line for line in frame_lines()), repr(frame_lines())
    row=next(i for i,line in enumerate(frame_lines()) if line=='· note two.md')
    mouse(0,3,row); mouse(0,3,row,True)
    expect_draft('@human Inspect `./explorer fixtures/note two.md` ')
    send(b'\x15@human Inspect ./no-match')
    assert 'No matching files or folders.' in '\n'.join(frame_lines())
    send(b'\r')
    assert len(state()['messages'])==before_files
    send(b'\x1b')
    assert 'File explorer' not in '\n'.join(frame_lines())
    send(b'\x15')
    for prefix in ['./', '`./']:
        send(('@human Inspect '+prefix+'doc').encode())
        assert 'File explorer' in '\n'.join(frame_lines())
        send(b'\r')
        expect_draft('@human Inspect '+prefix+'docs/')
        send(b'road\r')
        expect_draft('@human Inspect `./docs/roadmap.md` ')
        assert 'File explorer' not in '\n'.join(frame_lines())
        assert len(state()['messages'])==before_files
        send(b'\x15')
    # Hold a selection while the peer completes. The display freezes, not the room.
    send(b'@codex Selection activity\r')
    ready_by=time.monotonic()+3
    while '  Selection activity' not in frame_lines() and time.monotonic()<ready_by:
        collect(0.05)
    count=len(state()['messages'])
    row=next(i for i,line in enumerate(frame_lines()) if line=='  Selection activity')
    mouse(0,2,row); mouse(32,10,row)
    selected=b'\x1b[30;103mSelection\x1b[0m'
    ready_by=time.monotonic()+3
    while selected not in frame_bytes() and time.monotonic()<ready_by:
        collect(0.05)
    assert selected in frame_bytes(), 'Selection must be visible before releasing the peer'
    held=frame_lines()[:-1]
    (base/'state'/'release-selection-peer').touch()
    completed_by=time.monotonic()+5
    while len(state()['messages'])<count+1 and time.monotonic()<completed_by:
        collect(0.05)
        assert frame_lines()[:-1]==held, 'Incoming output moved text during selection'
    collect()
    assert frame_lines()[:-1]==held, 'Incoming output moved text during selection'
    assert len(state()['messages'])==count+1, 'Selecting text must let the agent finish'
    mouse(0,10,row,True)
    assert clipboard()=='Selection'
    send(b'\x1b')
    wrapped='Wrap'+'x'*100+'\n  indented'
    send(b'\x1b[200~@human ```\n'+wrapped.encode()+b'\n```\x1b[201~\r')
    first=next(i for i,line in enumerate(frame_lines()) if line.startswith('  Wrap'))
    last=next(i for i,line in enumerate(frame_lines()) if line=='    indented')
    mouse(0,2,first); mouse(32,11,last); mouse(0,11,last,True)
    assert clipboard()==wrapped, repr(clipboard())
    send(b'\x16')
    collect(0.3)
    assert state()['composerDraft']==wrapped, 'Multiline clipboard paste must preserve text and newlines'
    # Copy the wrapped composer without including its display name or continuation padding.
    composer=next(i for i,line in enumerate(frame_lines()) if line.startswith('Bill McGlone › Wrap'))
    mouse(0,15,composer); mouse(32,24,composer+2); mouse(0,24,composer+2,True)
    assert clipboard()==wrapped, repr(clipboard())
    send(b'\x1b')
    send(b'\x15\x7f\x15')  # Clear last logical line, its newline, and first line.
    collect(0.3)
    assert state()['composerDraft']==''
    send(b'a'*83)
    send(b'\x1b[AX')
    collect(0.3)
    assert state()['composerDraft']=='aaX'+'a'*81, 'Wrapped cursor movement must account for the display-name width'
    send(b'\x05\x15')
    # Attachment command input never becomes the accepted caption, including reply drafts.
    send(b'/reply #m1 retained caption')
    before_images=len(state()['messages'])
    send(b'\x0f')
    assert 'Attach › /attach ' in '\n'.join(frame_lines())
    send(b'./photo')
    expect_draft('/reply #m1 retained caption')
    assert 'File explorer' not in '\n'.join(frame_lines()), 'Shared ./ completion leaked into attachment input'
    send(b'\t')
    assert '/attach "./photo one.png"' in '\n'.join(frame_lines())
    send(b'\r'); collect(0.3)
    expect_draft('/reply #m1 retained caption')
    attachment=state()['composerAttachments'][0]
    assert attachment['id'] in '\n'.join(frame_lines())
    assert len(state()['messages'])==before_images
    send(b'\x0f--list\r')
    expect_draft('/reply #m1 retained caption')
    send(b'\x0funused caption\x1b')
    expect_draft('/reply #m1 retained caption')
    send(b'\x0fmissing.png\r'); collect(0.2)
    expect_draft('/reply #m1 retained caption')
    assert 'Attachment error:' in '\n'.join(frame_lines())
    send(b'\x0f--remove '+attachment['id'].encode()+b'\r'); collect(0.2)
    assert state()['composerAttachments']==[]
    expect_draft('/reply #m1 retained caption')
    send(b'\x0fphoto one.png\r'); collect(0.2)
    staged=state()['composerAttachments'][0]['id']
    (workspace/'photo one.png').unlink()
    send(b'\r'); collect(0.3)
    message=state()['messages'][-1]
    assert message['text']=='retained caption' and message['replyTo']==['m1']
    assert message['attachments'][0]['id']==staged
    assert message['attachmentOperation']['id']
    assert state()['composerAttachments']==[]
    expect_draft('')
    assert str(workspace/'photo one.png') not in json.dumps(state())
    # Exercise styled Markdown in the real viewport and copy from its margin.
    markdown='# Heading\n\nMarkdown **bold** and `inline`'
    send(b'\x1b[200~@human '+markdown.encode()+b'\x1b[201~\r')
    assert state()['messages'][-1]['text']==markdown, 'Rendering must preserve saved Markdown'
    assert '  Heading' in frame_lines()
    assert b'\x1b[1m' in frame_bytes() and b'\x1b[36m' in frame_bytes(), 'Markdown styles must survive painting'
    row=next(i for i,line in enumerate(frame_lines()) if line=='  Markdown bold and inline')
    mouse(0,0,row); mouse(32,25,row); mouse(0,25,row,True)
    assert clipboard()=='Markdown bold and inline', repr(clipboard())
    send(b'\x03')
    assert clipboard()=='Markdown bold and inline', 'Ctrl+C must recopy rendered Markdown'
    send(b'\x1b')
    send('Retained draft 🧪'.encode())
    send(b'\x04')
    proc.wait(timeout=5)
    collect()
    saved=state()
    assert proc.returncode==0
    assert saved['composerDraft']=='Retained draft 🧪'
    assert saved['paused'] is True
    assert b'\x1b[<u' in output and b'\x1b[?2004l' in output and b'\x1b[?1049l' in output
    assert b'\x1b[?1002l' in output and b'\x1b[?1006l' in output
    assert saved['workspace']==str(workspace)
    assert all(m['author']=='human' for m in saved['messages'] if m['author']!='codex'), 'The display name must not change stored participant identity'
    print('PASS PTY: Markdown styling and rendered copying from display padding, source preservation, attachment action isolation, Tab literal path, staging/list/removal, cancellation/error caption preservation, copied-byte reply send, highlighted drag selection, clipboard copy/paste and error recovery, wrapped transcript/composer copying, selection during agent activity, wheel/keyboard scrolling, Enter/Ctrl+J/Ctrl+Enter, bracketed paste, completion, automatic file explorer with folder navigation and mouse selection, Unicode draft, save and terminal restoration')
finally:
    if proc.poll() is None: proc.kill(); proc.wait()
    os.close(master); shutil.rmtree(base)
