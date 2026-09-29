import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ToolService } from '../dist/tools.js';
import { discoverSkills } from '../dist/skills.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { builtFile } from '../dist/tools.js';
const base = realpathSync(mkdtempSync(join(tmpdir(), 'chittr-security-'))),
  workspace = join(base, 'workspace');
mkdirSync(workspace);
writeFileSync(join(workspace, 'inside.txt'), 'inside-marker');
writeFileSync(join(base, 'outside.txt'), 'outside-marker');
symlinkSync(join(base, 'outside.txt'), join(workspace, 'escape'));
const server = createServer((req, res) => res.end('network-marker'));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;
const services = [];
let mcpClient;
try {
  const home = join(base, 'home');
  const source = join(base, 'skill-store/review');
  const link = join(home, '.agents/skills/review');
  const projectSkill = join(workspace, '.agents/skills/project');
  for (const folder of [join(home, '.agents/skills'), source, projectSkill])
    mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(source, 'SKILL.md'),
    '---\nname: fixture-review\ndescription: Test inspection\n---\nRead helper.sh',
  );
  writeFileSync(join(source, 'helper.sh'), 'printf skill-marker');
  writeFileSync(join(projectSkill, 'SKILL.md'), 'Project skill');
  symlinkSync(source, link);
  symlinkSync(join(base, 'outside.txt'), join(source, 'escape'));
  const bundles = discoverSkills('codex', workspace, home).bundles;
  const skillTools = new ToolService(
    workspace,
    { edits: true, commands: true, network: false },
    undefined,
    bundles,
  );
  services.push(skillTools);
  await skillTools.check();
  assert.match(
    (await skillTools.call('read_file', { path: join(link, 'SKILL.md') })).text,
    /fixture-review/,
  );
  assert.match(
    (await skillTools.call('read_file', { path: join(source, 'helper.sh') })).text,
    /skill-marker/,
  );
  assert.ok(
    (await skillTools.call('list_files', { path: link })).entries.some((e) =>
      e.endsWith('SKILL.md'),
    ),
  );
  await assert.rejects(
    skillTools.call('read_file', { path: join(link, 'escape') }),
    /outside.*bundles/,
  );
  await assert.rejects(
    skillTools.call('write_file', { path: join(source, 'SKILL.md'), text: 'bad' }),
    /read-only/,
  );
  await assert.rejects(
    skillTools.call('write_file', { path: join(projectSkill, 'SKILL.md'), text: 'bad' }),
    /read-only/,
  );
  let skillResult = await skillTools.call('run_command', {
    command: `/bin/sh '${source}/helper.sh'`,
  });
  assert.equal(skillResult.stdout, 'skill-marker');
  for (const file of [join(source, 'SKILL.md'), join(projectSkill, 'SKILL.md')]) {
    skillResult = await skillTools.call('run_command', { command: `printf bad > '${file}'` });
    assert.notEqual(skillResult.exitCode, 0, 'Commands cannot modify skill bundles');
  }
  skillResult = await skillTools.call('run_command', { command: `cat '${source}/escape'` });
  assert.notEqual(skillResult.exitCode, 0);
  assert.doesNotMatch(skillResult.stdout, /outside-marker/);
  console.log(
    'PASS linked skill reads, supporting scripts, nested escape denial, read-only skills even with edits/commands granted',
  );
  const read = new ToolService(workspace, { edits: false, commands: false, network: false });
  services.push(read);
  await read.check();
  assert.equal((await read.call('read_file', { path: 'inside.txt' })).text, 'inside-marker');
  await assert.rejects(read.call('read_file', { path: '../outside.txt' }), /launch directory/);
  await assert.rejects(read.call('read_file', { path: 'escape' }), /Symlink/);
  await assert.rejects(
    read.call('read_file', { path: join(link, 'SKILL.md') }),
    /launch directory/,
  );
  for (const [name, args] of [
    ['write_file', { path: 'bad.txt', text: 'bad' }],
    ['run_command', { command: 'true' }],
    ['fetch_url', { url }],
  ])
    await assert.rejects(read.call(name, args), /Missing permission/);
  console.log(
    'PASS default inspection, parent and symlink fencing, independent missing permissions',
  );
  const commands = new ToolService(workspace, { edits: false, commands: true, network: false });
  services.push(commands);
  await commands.check();
  let r = await commands.call('run_command', { command: 'cat inside.txt' });
  assert.equal(r.exitCode, 0, r.stderr);
  assert.match(r.stdout, /inside-marker/);
  r = await commands.call('run_command', { command: 'cat ../outside.txt' });
  assert.notEqual(r.exitCode, 0);
  assert.doesNotMatch(r.stdout, /outside-marker/);
  r = await commands.call('run_command', { command: 'printf bad > denied.txt' });
  assert.notEqual(r.exitCode, 0);
  assert.equal(existsSync(join(workspace, 'denied.txt')), false);
  r = await commands.call('run_command', { command: `/usr/bin/curl --max-time 2 '${url}'` });
  assert.notEqual(r.exitCode, 0);
  console.log('PASS command sandbox blocks outside reads, writes, and network independently');
  const writes = new ToolService(workspace, { edits: true, commands: false, network: true });
  services.push(writes);
  await writes.check();
  await writes.call('write_file', { path: 'nested/new.txt', text: 'written' });
  assert.equal(readFileSync(join(workspace, 'nested/new.txt'), 'utf8'), 'written');
  await assert.rejects(
    writes.call('write_file', { path: '../outside.txt', text: 'bad' }),
    /launch directory/,
  );
  assert.equal((await writes.call('fetch_url', { url })).text, 'network-marker');
  console.log('PASS explicit edit and network grants, still fenced to workspace for task files');

  const commandHome = join(base, 'command-home');
  const bin = join(commandHome, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(commandHome, 'config'), 'external-config');
  writeFileSync(
    join(bin, 'fixture-helper'),
    '#!/bin/sh\ncat "$HOME/config"\nprintf " %s" "$GOOGLE_APPLICATION_CREDENTIALS"\nprintf written > "$HOME/state"\n',
    { mode: 0o700 },
  );
  const trusted = new ToolService(
    workspace,
    { edits: true, commands: true, network: true },
    undefined,
    bundles,
    {
      mode: 'trusted',
      environment: {
        HOME: commandHome,
        PATH: `${bin}:/usr/bin:/bin`,
        GOOGLE_APPLICATION_CREDENTIALS: 'unfiltered-marker',
      },
    },
  );
  services.push(trusted);
  const settings = await trusted.mcpSettings('fixture');
  assert.doesNotMatch(JSON.stringify(settings), /unfiltered-marker/);
  const networkCommands = new ToolService(workspace, {
    edits: true,
    commands: true,
    network: true,
  });
  services.push(networkCommands);
  const connectScript = `const s=require('net').createConnection(process.argv[1]);s.on('error',e=>{console.log('DENIED:'+e.code);process.exit(1)});s.on('connect',()=>{console.log('CONNECTED');s.destroy()});`;
  const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  for (const socket of [
    settings.commandEndpoint.socket,
    settings.commandEndpoint.socket.replace('/private/tmp/', '/tmp/'),
  ]) {
    const attempt = await networkCommands.call('run_command', {
      command: `${shellQuote(process.execPath)} -e ${shellQuote(connectScript)} ${shellQuote(socket)}`,
    });
    assert.notEqual(
      attempt.exitCode,
      0,
      'A sandboxed command must not connect to the room executor',
    );
    assert.match(attempt.stdout, /DENIED:EPERM|DENIED:EACCES/, attempt.stderr);
    assert.doesNotMatch(attempt.stdout, /CONNECTED/);
  }
  const secretRead = await networkCommands.call('run_command', {
    command: `cat ${shellQuote(settings.commandEndpoint.credentialFile)}`,
  });
  assert.notEqual(secretRead.exitCode, 0);
  assert.equal(secretRead.stdout, '');
  // System curl needs an OpenSSL config outside the existing read roots. Use
  // Node so this checks networking itself, without widening runtime file access.
  const httpCommand = `${shellQuote(process.execPath)} -e ${shellQuote(`require('http').get(${JSON.stringify(url)},r=>r.pipe(process.stdout)).on('error',e=>{console.error(e.code);process.exit(1)})`)}`;
  assert.equal(
    (await networkCommands.call('run_command', { command: httpCommand })).stdout,
    'network-marker',
  );
  const deniedNetwork = await commands.call('run_command', { command: httpCommand });
  assert.notEqual(deniedNetwork.exitCode, 0);
  assert.match(deniedNetwork.stderr, /EPERM|EACCES/);
  console.log(
    'PASS actual broker socket connections and credential reads denied with commands, edits and network enabled; ordinary networking still works',
  );

  mcpClient = new Client({ name: 'trusted-command-probe', version: '1' });
  await mcpClient.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [builtFile('mcp.js'), JSON.stringify(settings)],
      env: { HOME: join(base, 'isolated-provider-home'), PATH: '/usr/bin:/bin' },
    }),
  );
  const response = await mcpClient.callTool({
    name: 'run_command',
    arguments: { command: 'fixture-helper' },
  });
  assert.equal(response.isError, undefined, JSON.stringify(response));
  assert.deepEqual(JSON.parse(response.content[0].text), {
    exitCode: 0,
    stdout: 'external-config unfiltered-marker',
    stderr: '',
  });
  assert.equal(readFileSync(join(commandHome, 'state'), 'utf8'), 'written');
  const fileResponse = await mcpClient.callTool({
    name: 'read_file',
    arguments: { path: join(commandHome, 'config') },
  });
  assert.equal(fileResponse.isError, true, 'Trusted commands must not widen file-tool reads');
  const toolList = await mcpClient.listTools();
  assert.match(
    toolList.tools.find((tool) => tool.name === 'run_command').description,
    /outside the workspace/,
  );
  console.log(
    'PASS real MCP forwarding from isolated HOME/PATH uses captured launch environment, external helper dependencies, config and state; file tools remain fenced',
  );
} finally {
  await mcpClient?.close();
  for (const s of services) s.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  rmSync(base, { recursive: true, force: true });
}
