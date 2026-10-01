import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import type { WebState } from '../../src/web-types.js';
import { participantStatus } from '../../src/participant-status.js';

async function state(page: Page): Promise<WebState> {
  return (await page.request.get('/api/state', { headers: await authHeaders(page) })).json();
}
async function authHeaders(page: Page) {
  return {
    Authorization: `Bearer ${await page.evaluate(() => sessionStorage.getItem('chittr:token'))}`,
  };
}
test.beforeEach(async ({ page }) => {
  const { url } = JSON.parse(readFileSync('.local/web-fixture.json', 'utf8'));
  await page.goto(url);
  await expect(page.getByRole('button', { name: 'New conversation', exact: false })).toBeEnabled();
  await page.getByRole('button', { name: 'New conversation', exact: false }).click();
  await expect(page.locator('[data-message-id]')).toHaveCount(0);
});
test('keeps room credentials out of cookies and requires the launch link in a new tab', async ({
  page,
  context,
}) => {
  expect((await context.cookies()).filter((cookie) => cookie.name.startsWith('chittr-'))).toEqual(
    [],
  );
  expect(new URL(page.url()).hash).toBe('');
  const second = await context.newPage();
  try {
    await second.goto('/');
    await expect(
      second.getByText('Open the browser link printed by chittr to connect.'),
    ).toBeVisible();
    await expect(second.locator('[data-message-id]')).toHaveCount(0);
    const { url } = JSON.parse(readFileSync('.local/web-fixture.json', 'utf8'));
    await second.goto(url);
    await expect(
      second.getByRole('button', { name: 'New conversation', exact: false }),
    ).toBeEnabled();
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    await composer.fill('@human Private fixture ✓');
    await composer.press('Enter');
    await expect(second.locator('[data-message-id="m1"]')).toContainText('Private fixture ✓');
    await second.reload();
    await expect(second.locator('[data-message-id="m1"]')).toContainText('Private fixture ✓');
    expect((await context.cookies()).filter((cookie) => cookie.name.startsWith('chittr-'))).toEqual(
      [],
    );
  } finally {
    await second.close();
  }
});
test('reconnects the authenticated event stream after a lost connection', async ({ page }) => {
  let connections = 0;
  let authenticated = true;
  await page.route('**/api/events', async (route) => {
    connections++;
    authenticated &&= /^Bearer [a-f0-9]{64}$/.test(route.request().headers().authorization ?? '');
    if (connections === 1) await route.abort();
    else await route.continue();
  });
  await page.reload();
  await expect(page.getByRole('button', { name: 'New conversation', exact: false })).toBeEnabled();
  expect(connections).toBeGreaterThanOrEqual(2);
  expect(authenticated).toBe(true);
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('@human Reconnected ✓');
  await composer.press('Enter');
  await expect(page.locator('[data-message-id="m1"]')).toContainText('Reconnected ✓');
});
test('shows actual catch-up steps and separates paused replies from ongoing recovery', async ({
  page,
}) => {
  const snapshot = await state(page);
  const agent = snapshot.agents.find((a) => a.id === 'codex')!;
  Object.assign(agent, {
    connection: 'connecting',
    activity: 'available',
    paused: true,
    active: undefined,
    maintenance: {
      id: 'recovery',
      agent: 'codex',
      purpose: 'recovery',
      route: 'replacement',
      status: 'running',
      startedAt: new Date().toISOString(),
      detail: 'Summarizing earlier messages (1 of 2)',
    },
  });
  ({ status: agent.status, detail: agent.statusDetail } = participantStatus(agent));
  await page.route('**/api/connect', (route) => route.fulfill({ json: snapshot }));
  await page.route('**/api/events', (route) => route.abort());
  await page.reload();
  const card = page
    .locator('.agent-card')
    .filter({ has: page.locator('strong', { hasText: /^codex$/ }) });
  await expect(card.locator('.agent-activity')).toHaveText(
    'Catching up on the chat · replies paused',
  );
  await expect(card.locator('.agent-detail')).toHaveText('Summarizing earlier messages (1 of 2)');
  await expect(card).not.toContainText('Ready for your next message');
  agent.maintenance!.detail = 'Loading the chat context into a fresh session';
  ({ status: agent.status, detail: agent.statusDetail } = participantStatus(agent));
  await page.reload();
  await expect(card.locator('.agent-detail')).toHaveText(agent.maintenance!.detail);
  await expect(card).toContainText('Catch-up: running');
  await page.screenshot({ path: '.local/provider-recovery.png' });
});
test('keeps a running tool visible while requested compaction waits for the turn', async ({
  page,
}) => {
  const snapshot = await state(page);
  const agent = snapshot.agents.find((a) => a.id === 'codex')!;
  Object.assign(agent, {
    connection: 'ready',
    activity: 'working',
    detail: 'read_file',
    paused: false,
    active: { startedAt: new Date().toISOString(), messageIds: ['m1'] },
    maintenance: {
      id: 'compact',
      agent: 'codex',
      purpose: 'compaction',
      route: 'native',
      status: 'waiting',
      startedAt: new Date().toISOString(),
      detail: 'Waiting for current turn',
    },
  });
  ({ status: agent.status, detail: agent.statusDetail } = participantStatus(agent));
  await page.route('**/api/connect', (route) => route.fulfill({ json: snapshot }));
  await page.route('**/api/events', (route) => route.abort());
  await page.reload();
  const card = page
    .locator('.agent-card')
    .filter({ has: page.locator('strong', { hasText: /^codex$/ }) });
  await expect(card.locator('.agent-activity')).toHaveText('Working');
  await expect(card.locator('.agent-detail')).toHaveText('read_file');
  await expect(card.locator('.agent-context')).toContainText(
    'Compaction: waiting · Waiting for current turn',
  );
});
test('composer arrows recall sent messages and return to the unsent draft without wrapping', async ({
  page,
}) => {
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.press('ArrowDown');
  await expect(composer).toHaveValue('');
  await composer.press('ArrowUp');
  await expect(composer).toHaveValue('');
  await composer.fill('@human First message');
  await composer.press('Enter');
  await expect(composer).toHaveValue('');
  await composer.fill('@codex Last message\nWith details');
  await composer.press('Enter');
  await expect(composer).toHaveValue('');
  await expect(page.locator('[data-message-id="m3"]')).toBeVisible();

  await composer.press('ArrowDown');
  await expect(composer).toHaveValue('');
  await composer.press('ArrowUp');
  await expect(composer).toHaveValue('@codex Last message\nWith details');
  await composer.press('ArrowUp');
  await expect(composer).toHaveValue('@human First message');
  await composer.press('ArrowUp');
  await expect(composer).toHaveValue('@human First message');
  await composer.press('ArrowDown');
  await expect(composer).toHaveValue('@codex Last message\nWith details');
  await composer.press('ArrowDown');
  await expect(composer).toHaveValue('');
  await composer.press('ArrowDown');
  await expect(composer).toHaveValue('');

  await composer.fill('Unsent draft');
  await composer.press('ArrowUp');
  await expect(composer).toHaveValue('@codex Last message\nWith details');
  await composer.press('ArrowDown');
  await expect(composer).toHaveValue('Unsent draft');
  await composer.press('ArrowUp');
  await composer.press('End');
  await composer.press('!');
  await composer.press('ArrowDown');
  await expect(composer).toHaveValue('@codex Last message\nWith details!');
  await composer.press('Enter');
  await expect(composer).toHaveValue('');
  await composer.press('ArrowDown');
  await expect(composer).toHaveValue('');
  await composer.press('ArrowUp');
  await expect(composer).toHaveValue('@codex Last message\nWith details!');

  await page.getByRole('button', { name: 'New conversation', exact: false }).click();
  await expect(page.locator('[data-message-id]')).toHaveCount(0);
  await composer.press('ArrowDown');
  await composer.press('ArrowUp');
  await expect(composer).toHaveValue('');
});

test('composer history restores reply targets and keeps multiline editing and completion navigation', async ({
  page,
}) => {
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  const preview = page.getByRole('group', { name: 'Reply preview' });
  await composer.fill('@human Original');
  await composer.press('Enter');
  await expect(composer).toHaveValue('');
  await page
    .locator('[data-message-id="m1"]')
    .getByRole('button', { name: 'Reply', exact: true })
    .click();
  await composer.fill('@human Reply');
  await composer.press('Enter');
  await expect(composer).toHaveValue('');
  await page.reload();
  await expect(composer).toBeEnabled();
  await composer.press('ArrowUp');
  await expect(composer).toHaveValue('@human Reply');
  await expect(preview).toContainText('#m1');
  await composer.press('ArrowUp');
  await expect(composer).toHaveValue('@human Original');
  await expect(preview).toHaveCount(0);
  await composer.press('ArrowDown');
  await expect(preview).toContainText('#m1');
  await composer.press('ArrowDown');
  await expect(composer).toHaveValue('');
  await expect(preview).toHaveCount(0);

  await page
    .locator('[data-message-id="m2"]')
    .getByRole('button', { name: 'Reply', exact: true })
    .click();
  await composer.fill('Draft reply');
  await composer.press('ArrowUp');
  await expect(preview).toContainText('#m1');
  await composer.press('ArrowDown');
  await expect(composer).toHaveValue('Draft reply');
  await expect(preview).toContainText('#m2');

  await composer.fill('First line\nSecond line');
  await composer.press('ArrowUp');
  await expect(composer).toHaveValue('First line\nSecond line');
  await composer.press('ArrowDown');
  await expect(composer).toHaveValue('First line\nSecond line');
  await composer.fill('@');
  await expect(page.getByRole('listbox')).toBeVisible();
  await composer.press('ArrowUp');
  await composer.press('ArrowDown');
  await expect(composer).toHaveValue('@');
});

test('pins human and agent messages, keeps drafts, restores pins, and unpins on mobile', async ({
  page,
}) => {
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  const pins = page.getByRole('button', { name: /^Pinned messages/ });
  const dialog = page.getByRole('dialog', { name: 'Pinned messages', exact: true });
  await pins.click();
  await expect(dialog).toContainText('No pinned messages');
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await composer.fill('@codex Keep this decision');
  await composer.press('Enter');
  const human = page.locator('[data-message-id="m1"]');
  const agent = page.locator('[data-message-id="m2"]');
  await expect(agent).toBeVisible();
  await composer.fill('Unsent draft');
  await agent.getByRole('button', { name: 'Pin message', exact: true }).click();
  await expect(pins).toHaveText('Pinned messages (1)');
  await human.getByRole('button', { name: 'Pin message', exact: true }).click();
  await expect(pins).toHaveText('Pinned messages (2)');
  await expect(composer).toHaveValue('Unsent draft');
  await expect(agent.getByRole('button', { name: 'Unpin message' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.reload();
  await expect(pins).toHaveText('Pinned messages (2)');
  await pins.click();
  await expect(dialog.locator('h3')).toHaveText(['#m1 · Bill', '#m2 · @codex']);
  await expect(dialog).toContainText('Keep this decision');
  await expect(dialog.locator('pre')).toContainText('const room = new Room(config, store);');
  await page.screenshot({ path: '.local/web-pins-desktop.png', fullPage: true });
  await dialog.getByRole('button', { name: 'Go to message' }).first().click();
  await expect(dialog).toHaveCount(0);
  await expect(human).toBeInViewport();
  await expect(composer).toHaveValue('Unsent draft');
  const savedId = (await state(page)).session.id;
  await page.getByRole('button', { name: 'New conversation', exact: false }).click();
  await expect(pins).toHaveText('Pinned messages (0)');
  await composer.fill('/sessions ' + savedId);
  await composer.press('Enter');
  await expect(pins).toHaveText('Pinned messages (2)');
  await page.setViewportSize({ width: 390, height: 844 });
  await pins.click();
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.local/web-pins-mobile.png', fullPage: true });
  await dialog.getByRole('button', { name: 'Unpin', exact: true }).first().click();
  await expect(dialog.locator('h3')).toHaveText(['#m2 · @codex']);
  await dialog.getByRole('button', { name: 'Unpin', exact: true }).click();
  await expect(dialog).toContainText('No pinned messages');
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await expect(pins).toHaveText('Pinned messages (0)');
  expect((await state(page)).session.messages).toHaveLength(2);
});

test('replies to a message, preserves the draft through incoming replies and refresh, and cancels on mobile', async ({
  page,
}) => {
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  const preview = page.getByRole('group', { name: 'Reply preview' });
  await composer.fill('@codex Explain the options');
  await composer.press('Enter');
  await expect(page.locator('[data-message-id="m2"]')).toBeVisible();
  await composer.fill('My answer\nWith details');
  await page
    .locator('[data-message-id="m2"]')
    .getByRole('button', { name: 'Reply', exact: true })
    .click();
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue('My answer\nWith details');
  await expect(preview).toContainText('Replying to @codex #m2');
  // An independent incoming turn must not replace the reply target or text.
  const snapshot = await state(page);
  await page.request.post('/api/command', {
    headers: await authHeaders(page),
    data: {
      id: crypto.randomUUID(),
      sessionId: snapshot.session.id,
      line: '@claude Another question',
    },
  });
  await expect(page.locator('[data-message-id="m4"]')).toBeVisible();
  await expect(preview).toContainText('#m2');
  await expect(composer).toHaveValue('My answer\nWith details');
  await page.reload();
  await expect(preview).toContainText('Replying to @codex #m2');
  await expect(composer).toHaveValue('My answer\nWith details');
  await page.screenshot({ path: '.local/web-reply-desktop.png', fullPage: true });
  await composer.press('Enter');
  await expect(preview).toHaveCount(0);
  await expect(composer).toHaveValue('');
  const sent = (await state(page)).session.messages.find(
    (message) => message.text === 'My answer\nWith details',
  )!;
  expect(sent.replyTo).toEqual(['m2']);
  expect(sent.recipients).toEqual(['codex']);
  await expect(page.locator(`[data-message-id="${sent.id}"] .reply-links a`)).toHaveAttribute(
    'href',
    '#m2',
  );
  await expect.poll(async () => (await state(page)).idle).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .locator('[data-message-id="m2"]')
    .getByRole('button', { name: 'Reply', exact: true })
    .click();
  await composer.fill('Keep this draft');
  await expect(preview).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.local/web-reply-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Cancel reply' }).click();
  await expect(preview).toHaveCount(0);
  await expect(composer).toHaveValue('Keep this draft');
  await expect(composer).toBeFocused();
  await page.reload();
  await expect(preview).toHaveCount(0);
  await expect(composer).toHaveValue('Keep this draft');
});

test('keeps reply targets on failed sends, recovers lost acknowledgments once, and clears them on session changes', async ({
  page,
}) => {
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  const preview = page.getByRole('group', { name: 'Reply preview' });
  await composer.fill('@human Original');
  await composer.press('Enter');
  await page
    .locator('[data-message-id="m1"]')
    .getByRole('button', { name: 'Reply', exact: true })
    .click();
  await composer.fill('@missing Keep my reply');
  await composer.press('Enter');
  await expect(page.getByRole('alert')).toContainText('Unknown recipient');
  await expect(preview).toContainText('#m1');
  await expect(composer).toHaveValue('@missing Keep my reply');
  await page.route(
    '**/api/command',
    async (route) => {
      await route.fetch();
      await route.abort('failed');
    },
    { times: 1 },
  );
  await composer.fill('@human Sent once');
  await composer.press('Enter');
  await expect(page.getByRole('button', { name: 'Check last action' })).toBeVisible();
  await page.reload();
  await expect(preview).toContainText('#m1');
  await page.getByRole('button', { name: 'Check last action' }).click();
  await expect(preview).toHaveCount(0);
  await expect(composer).toHaveValue('');
  expect(
    (await state(page)).session.messages.filter((message) => message.text === 'Sent once'),
  ).toEqual([expect.objectContaining({ replyTo: ['m1'], recipients: ['human'] })]);
  await page
    .locator('[data-message-id="m1"]')
    .getByRole('button', { name: 'Reply', exact: true })
    .click();
  await composer.fill('Saved reply draft');
  const previousId = (await state(page)).session.id;
  await expect
    .poll(async () => (await state(page)).session.composerDraft)
    .toBe('/reply #m1 Saved reply draft');
  await page.getByRole('button', { name: 'New conversation', exact: false }).click();
  await expect(preview).toHaveCount(0);
  await expect(composer).toHaveValue('');
  // Remove the tab's copy to exercise the persisted draft when returning to the old session.
  await page.evaluate(() => {
    for (const key of Object.keys(sessionStorage))
      if (key.endsWith(':draft')) sessionStorage.removeItem(key);
  });
  await composer.fill('/sessions ' + previousId);
  await composer.press('Enter');
  await expect(preview).toContainText('#m1');
  await expect(composer).toHaveValue('Saved reply draft');
  await composer.press('Escape');
  await expect(preview).toHaveCount(0);
  await expect(composer).toHaveValue('Saved reply draft');
});

test('shows trusted access and inactive reasons after reload on desktop and mobile', async ({
  page,
}) => {
  const { workspace, home } = JSON.parse(readFileSync('.local/web-fixture.json', 'utf8'));
  const user = join(home, '.agents/chittr.yaml'),
    project = join(workspace, '.agents/chittr.yaml');
  const originalUser = readFileSync(user, 'utf8');
  const originalProject = existsSync(project) ? readFileSync(project, 'utf8') : undefined;
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  const reload = async () => {
    await composer.fill('/reload');
    await composer.press('Enter');
  };
  try {
    mkdirSync(join(workspace, '.agents'), { recursive: true });
    writeFileSync(
      user,
      originalUser + `\ntrustedCommands: {workspaces: [${JSON.stringify(workspace)}]}\n`,
    );
    writeFileSync(
      project,
      'version: 1\npermissions: {edits: true, commands: true, network: true}\n',
    );
    await reload();
    await expect(page.locator('.command-access')).toContainText(
      'Trusted commands: read, write, network',
    );
    await expect(page.locator('.command-access')).toContainText(user);
    await page.screenshot({ path: '.local/trusted-commands-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('.command-access')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: '.local/trusted-commands-mobile.png', fullPage: true });
    writeFileSync(
      project,
      'version: 1\npermissions: {edits: true, commands: true, network: false}\n',
    );
    await reload();
    await expect(page.locator('.command-access')).toContainText('Trust inactive');
    await expect(page.locator('.command-access')).toContainText(
      `permissions.network=false from ${project}`,
    );
    await composer.fill('/config');
    await composer.press('Enter');
    await expect
      .poll(async () => (await state(page)).session.notices.at(-1)?.text)
      .toContain('"mode": "sandboxed"');
  } finally {
    writeFileSync(user, originalUser);
    if (originalProject === undefined) rmSync(project, { force: true });
    else writeFileSync(project, originalProject);
    await reload();
  }
});
test('shows live context usage, unknown limits and fresh-session reset on desktop and mobile', async ({
  page,
}) => {
  const codex = page
    .locator('.agent-card')
    .filter({ has: page.locator('strong', { hasText: /^codex$/ }) });
  const claude = page
    .locator('.agent-card')
    .filter({ has: page.locator('strong', { hasText: /^claude$/ }) });
  await expect(codex.locator('.agent-context > span').first()).toHaveText('Context: unavailable');
  await expect(codex.getByRole('meter')).toHaveCount(0);
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('Show context usage');
  await composer.press('Enter');
  await expect(codex.locator('.agent-context')).toContainText(
    '48,000 / 200,000 tokens · 24.0% used',
  );
  await expect(codex.locator('.agent-context')).toContainText(
    '72,000 / 200,000 tokens · 36.0% used',
  );
  await expect(codex.getByRole('meter', { name: 'Context usage for codex' })).toHaveAttribute(
    'value',
    '72000',
  );
  await expect(claude.locator('.agent-context > span').first()).toHaveText(
    'Context: 72,000 tokens · limit unavailable',
  );
  await expect(claude.getByRole('meter')).toHaveCount(0);
  await expect.poll(async () => (await state(page)).idle).toBe(true);
  await composer.fill('/participants');
  await composer.press('Enter');
  await expect
    .poll(async () => (await state(page)).session.notices.at(-1)?.text)
    .toContain('Context: 72,000 / 200,000 tokens · 36.0% used');
  // The notice can arrive before the command response. Reload only after the
  // browser acknowledges it, otherwise the intentionally retained request needs retry.
  await expect(page.getByRole('button', { name: 'New conversation', exact: false })).toBeEnabled();
  await page.reload();
  await expect(codex.locator('.agent-context')).toContainText('36.0% used');
  await page.screenshot({ path: '.local/web-context-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(codex.locator('.agent-context')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.local/web-context-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'New conversation', exact: false }).click();
  await expect(codex.locator('.agent-context > span').first()).toHaveText('Context: unavailable');
});
test('streams concurrent replies, displays passes, copies Markdown, and preserves draft input', async ({
  page,
}) => {
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('Discuss the interface');
  await composer.press('Enter');
  await expect(page.locator('.agent-card.is-active')).toHaveCount(2);
  await composer.fill('My next thought\nA second line');
  await expect(page.locator('[data-message-id]')).toHaveCount(3);
  await expect(composer).toHaveValue('My next thought\nA second line');
  await expect(page.locator('.code-block')).toHaveCount(1);
  // Stub the browser clipboard to assert exact copied content without changing the host clipboard.
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async (text: string) => {
          (window as any).copied = text;
        },
      },
      configurable: true,
    });
  });
  await page.getByRole('button', { name: 'Copy code', exact: true }).click();
  expect(await page.evaluate(() => (window as any).copied)).toBe(
    'const room = new Room(config, store);\nawait room.start();',
  );
  await composer.fill('[pass]');
  await composer.press('Enter');
  await expect(page.getByText('has nothing to add', { exact: false })).toHaveCount(2);
  await page.screenshot({ path: '.local/web-desktop.png', fullPage: true });
});
test('browses files automatically, navigates folders and inserts quoted paths without sending', async ({
  page,
}) => {
  const { workspace } = JSON.parse(readFileSync('.local/web-fixture.json', 'utf8'));
  const directory = join(workspace, 'explorer fixtures');
  mkdirSync(join(directory, 'empty'), { recursive: true });
  writeFileSync(join(directory, 'note one.md'), 'A note');
  writeFileSync(join(directory, 'note two.md'), 'Another note');
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  const explorer = page.getByRole('listbox', { name: 'File explorer' });
  try {
    await composer.fill('Inspect ./');
    await expect(explorer).toBeVisible();
    await page.getByRole('option', { name: 'Open folder explorer fixtures/', exact: true }).click();
    await expect(composer).toHaveValue('Inspect "./explorer fixtures/');
    await expect(explorer.getByRole('option')).toHaveCount(3);
    await composer.press('Enter');
    await expect(composer).toHaveValue('Inspect "./explorer fixtures/empty/');
    await expect(page.getByText('No matching files or folders.', { exact: true })).toBeVisible();
    await composer.press('Enter');
    await expect(page.locator('[data-message-id]')).toHaveCount(0);
    await composer.press('Alt+ArrowUp');
    await expect(explorer.getByRole('option')).toHaveCount(3);
    await composer.press('ArrowDown');
    await composer.press('Tab');
    await expect(composer).toHaveValue('Inspect `./explorer fixtures/note one.md` ');
    await expect(explorer).toHaveCount(0);
    await expect(page.locator('[data-message-id]')).toHaveCount(0);

    await composer.fill('Inspect "./explorer fixtures/note tw');
    await expect(explorer.getByRole('option')).toHaveCount(1);
    await expect(composer).toHaveValue('Inspect "./explorer fixtures/note tw');
    await composer.press('Enter');
    await expect(composer).toHaveValue('Inspect `./explorer fixtures/note two.md` ');
    await composer.fill('Inspect ./not-found');
    await expect(page.getByText('No matching files or folders.', { exact: true })).toBeVisible();
    await composer.press('Enter');
    await expect(page.locator('[data-message-id]')).toHaveCount(0);
    await composer.press('Escape');
    await expect(explorer).toHaveCount(0);

    await composer.fill('Inspect "./explorer fixtures/');
    await expect(explorer.getByRole('option')).toHaveCount(3);
    await page.screenshot({ path: '.local/file-explorer-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(explorer).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: '.local/file-explorer-mobile.png', fullPage: true });
    await page.getByRole('button', { name: 'Up one folder' }).click();
    await expect(composer).toHaveValue('Inspect ./');
    await expect(
      page.getByRole('option', { name: 'Open folder explorer fixtures/', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Close file explorer' }).click();
    await expect(explorer).toHaveCount(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test('wraps a completed path in backticks, with an optional opening backtick', async ({ page }) => {
  const { workspace } = JSON.parse(readFileSync('.local/web-fixture.json', 'utf8'));
  const docs = join(workspace, 'docs');
  mkdirSync(docs);
  writeFileSync(join(docs, 'roadmap.md'), 'A roadmap');
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  try {
    for (const prefix of ['./', '`./']) {
      await composer.fill('Inspect ' + prefix);
      await page.getByRole('option', { name: 'Open folder docs/', exact: true }).click();
      await expect(composer).toHaveValue('Inspect ' + prefix + 'docs/');
      await expect(
        page.getByRole('option', { name: 'Insert file roadmap.md', exact: true }),
      ).toBeVisible();
      await composer.press('Enter');
      await expect(composer).toHaveValue('Inspect `./docs/roadmap.md` ');
      await expect(page.getByRole('listbox', { name: 'File explorer' })).toHaveCount(0);
      await expect(page.locator('[data-message-id]')).toHaveCount(0);
    }
  } finally {
    rmSync(docs, { recursive: true, force: true });
  }
});
test('ignores a delayed file listing after Escape', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    '**/api/complete',
    async (route) => {
      const response = await route.fetch();
      await gate;
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('Inspect ./');
  await expect(page.getByText('Loading…', { exact: true })).toBeVisible();
  await composer.press('Enter');
  await expect(page.locator('[data-message-id]')).toHaveCount(0);
  await composer.press('Escape');
  const response = page.waitForResponse('**/api/complete');
  release();
  await response;
  await expect(page.getByRole('listbox', { name: 'File explorer' })).toHaveCount(0);
  await expect(composer).toHaveValue('Inspect ./');
});
test('completion, multiline input, safe Markdown and scroll position', async ({ page }) => {
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('@cod');
  await composer.press('Tab');
  await expect(composer).toHaveValue('@codex ');
  await composer.type('Inspect sam');
  await composer.press('Tab');
  await expect(composer).toHaveValue('@codex Inspect `sample.ts` ');
  await composer.press('Shift+Enter');
  await composer.type('Next line');
  await expect(page.locator('[data-message-id]')).toHaveCount(0);
  await composer.press('Enter');
  await expect(page.locator('[data-message-id]')).toHaveCount(2);
  await composer.fill(
    '@human <script>window.pwned=1</script>\n\n![hidden](https://example.com/tracker.png)\n\n[bad](javascript:alert(1))',
  );
  await composer.press('Enter');
  await expect(page.locator('[data-message-id]')).toHaveCount(3);
  await expect(page.locator('.markdown img')).toHaveCount(0);
  await expect(page.locator('.markdown a[href^="javascript:"]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).pwned)).toBeUndefined();
  for (let i = 0; i < 12; i++) {
    await composer.fill('@human Earlier message ' + i + '\n' + 'Some context.\n'.repeat(5));
    await composer.press('Enter');
    await expect(composer).toHaveValue('');
  }
  await page.locator('.transcript').evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(page.getByRole('button', { name: 'Jump to latest', exact: false })).toBeVisible();
  const before = await page.locator('.transcript').evaluate((element) => element.scrollTop);
  await composer.fill('@codex Keep discussing');
  await composer.press('Enter');
  await expect(page.locator('.agent-card.is-active')).toHaveCount(1);
  await expect.poll(async () => (await state(page)).idle).toBe(true);
  expect(await page.locator('.transcript').evaluate((element) => element.scrollTop)).toBe(before);
});
test('shows agent keys consistently in activity, completions, replies and delivery controls', async ({
  page,
}) => {
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await expect(page.locator('.sidebar-person strong', { hasText: 'codex' })).toBeVisible();
  const codexSettings = page
    .getByRole('group', { name: 'Participant codex', exact: true })
    .locator('dd');
  await expect(codexSettings).toHaveCount(2);
  await expect(codexSettings.nth(0)).toHaveText('provider default');
  await expect(codexSettings.nth(1)).toHaveText('provider default');
  await expect(page.locator('.agent-card strong', { hasText: 'codex' })).toBeVisible();
  await expect(page.locator('.agent-card strong', { hasText: 'claude' })).toBeVisible();
  await composer.fill('@');
  await composer.press('Tab');
  await page.getByRole('option', { name: '@codex', exact: true }).click();
  await expect(composer).toHaveValue('@codex ');
  await composer.fill('@codex Inspect this');
  await composer.press('Enter');
  await expect(page.locator('.streaming .message-heading strong')).toHaveText('codex');
  await expect(page.locator('[data-message-id]')).toHaveCount(2);
  await expect(page.locator('[data-message-id="m1"] .message-route')).toHaveText('to @codex');
  await expect(page.locator('[data-message-id="m1"] .delivery strong')).toHaveText('codex');
  await expect(page.locator('[data-message-id="m2"] .message-heading strong')).toHaveText('codex');
  const snapshot = await state(page);
  expect(snapshot.session.messages[0]!.recipients).toEqual(['codex']);
  expect(snapshot.session.messages[1]!.author).toBe('codex');
});
test('refresh restores drafts and lost acknowledgments can be checked without duplicate messages', async ({
  page,
}) => {
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('Unsent draft 🧪\nWith a newline');
  await page.reload();
  await expect(composer).toHaveValue('Unsent draft 🧪\nWith a newline');
  await expect(page.locator('[data-message-id]')).toHaveCount(0);
  await page.route(
    '**/api/command',
    async (route) => {
      await route.fetch();
      await route.abort('failed');
    },
    { times: 1 },
  );
  await composer.fill('@human Sent once');
  await composer.press('Enter');
  await expect(page.getByRole('button', { name: 'Check last action' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Check last action' })).toBeVisible();
  await page.getByRole('button', { name: 'Check last action' }).click();
  await expect(composer).toHaveValue('');
  expect((await state(page)).session.messages.filter((m) => m.text === 'Sent once')).toHaveLength(
    1,
  );
  await page.context().setOffline(true);
  await composer.fill('Draft while offline');
  await page.context().setOffline(false);
  await expect(page.getByRole('button', { name: 'Ⅱ Pause', exact: true })).toBeEnabled();
  await expect(composer).toHaveValue('Draft while offline');
});
test('room controls, saved conversation restore, and responsive layout', async ({ page }) => {
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await page.getByRole('button', { name: 'Controls for codex', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Close dialog' })).toBeFocused();
  await page.getByRole('dialog').getByRole('button', { name: 'Pause', exact: true }).click();
  await expect
    .poll(async () => (await state(page)).agents.find((a) => a.id === 'codex')?.paused)
    .toBe(true);
  expect((await state(page)).agents.find((a) => a.id === 'claude')?.paused).toBe(false);
  await page.getByRole('button', { name: 'Controls for codex', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Room configuration', exact: false }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Ⅱ Pause', exact: true }).click();
  await expect(page.getByRole('button', { name: '▷ Continue', exact: true })).toBeEnabled();
  await composer.fill('Queued discussion');
  await composer.press('Enter');
  await expect(page.locator('.agent-card.is-active')).toHaveCount(0);
  await expect
    .poll(async () => (await state(page)).agents.every((a) => a.pending.queued === 1))
    .toBe(true);
  await page.getByRole('button', { name: '▷ Continue', exact: true }).click();
  await expect(page.locator('.agent-card.is-active')).toHaveCount(2);
  await page.getByRole('button', { name: '□ Stop', exact: true }).click();
  await expect.poll(async () => (await state(page)).agents.every((a) => a.stopped)).toBe(true);
  const previous = (await state(page)).session.id;
  await page.getByRole('button', { name: 'New conversation', exact: false }).click();
  await expect(page.locator('[data-message-id]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Saved conversations', exact: false }).click();
  await page.getByRole('button', { name: /Queued discussion/ }).click();
  await expect.poll(async () => (await state(page)).session.id).toBe(previous);
  expect((await state(page)).session.paused).toBe(false);
  expect((await state(page)).agents.every((agent) => !agent.paused && !agent.stopped)).toBe(true);
  await expect(page.getByRole('button', { name: 'Ⅱ Pause', exact: true })).toBeEnabled();
  await composer.fill('@codex Reply after resume');
  await composer.press('Enter');
  await expect(page.locator('.agent-card.is-active')).toHaveCount(1);
  await expect.poll(async () => (await state(page)).idle).toBe(true);
  expect((await state(page)).session.messages.at(-1)?.author).toBe('codex');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(composer).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.local/web-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: '.local/web-dark.png', fullPage: true, animations: 'disabled' });
});

test('project agents replace the fallback roster in the room and sidebar after reload', async ({
  page,
}) => {
  const { workspace } = JSON.parse(readFileSync('.local/web-fixture.json', 'utf8'));
  const configPath = join(workspace, '.agents/chittr.yaml');
  mkdirSync(join(workspace, '.agents'), { recursive: true });
  writeFileSync(
    configPath,
    `version: 1
agents:
  astra: {provider: codex, model: gpt-6-astra, effort: high}
  sol: {provider: codex, model: gpt-5.6-sol, effort: medium}
  gemini: {provider: antigravity}
  disabled: {provider: codex, enabled: false, model: custom-very-long-model-name-that-must-wrap-in-the-sidebar, effort: low}
`,
  );
  try {
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    await composer.fill('/reload');
    await composer.press('Enter');
    await expect(page.getByRole('button', { name: '@astra', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '@sol', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '@gemini', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '@codex', exact: true })).toHaveCount(0);
    await expect(page.locator('.sidebar-person')).toHaveCount(5);
    await expect(page.locator('.sidebar-person strong', { hasText: 'claude' })).toHaveCount(0);
    await expect(page.locator('.sidebar-person strong', { hasText: 'gemini' })).toBeVisible();
    await expect(page.locator('.agent-card strong', { hasText: 'gemini' })).toBeVisible();
    await expect(page.locator('.agent-card')).toHaveCount(3);
    const astra = page.getByRole('group', { name: 'Participant astra', exact: true });
    const sol = page.getByRole('group', { name: 'Participant sol', exact: true });
    const gemini = page.getByRole('group', { name: 'Participant gemini', exact: true });
    const disabled = page.getByRole('group', { name: 'Participant disabled', exact: true });
    await expect(astra).toContainText('codex · @astra');
    for (const [participant, model, effort, id] of [
      [astra, 'gpt-6-astra', 'high', 'astra'],
      [sol, 'gpt-5.6-sol', 'medium', 'sol'],
      [gemini, 'provider default', 'provider default', 'gemini'],
    ] as const) {
      const settings = participant.locator('dd');
      await expect(settings).toHaveCount(2);
      await expect(settings.nth(0)).toHaveText(model);
      await expect(settings.nth(1)).toHaveText(effort);
      // Image status is no longer repeated in the sidebar.
      await expect(participant).not.toContainText('Initial images');
      await expect(participant).not.toContainText(`no initial-image route is enabled for @${id}`);
    }
    await expect(page.locator('.participant-image-reason, .agent-image-status')).toHaveCount(0);
    await expect(page.locator('.participant-strip')).not.toContainText('Initial images');
    await expect(disabled).toContainText('disabled');
    await expect(disabled.locator('dd')).toHaveText([
      'custom-very-long-model-name-that-must-wrap-in-the-sidebar',
      'low',
    ]);
    expect(
      await page
        .locator('.sidebar')
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await composer.fill('/part');
    await composer.press('Tab');
    await expect(composer).toHaveValue('/participants ');
    await composer.press('Enter');
    await expect
      .poll(async () => (await state(page)).session.notices.at(-1)?.text)
      .toContain('Model: gpt-6-astra · Effort: high');
    const participantNotice = (await state(page)).session.notices.at(-1)!.text;
    expect(participantNotice).toContain('@disabled · disabled');
    expect(participantNotice).toContain('Model: provider default · Effort: provider default');
    expect(participantNotice).toContain('Initial images: unsupported');
    expect((await state(page)).session.messages).toHaveLength(0);
    await page.screenshot({ path: '.local/web-participants.png', fullPage: true });
    expect((await state(page)).agents.filter((a) => a.enabled).map((a) => a.id)).toEqual([
      'astra',
      'sol',
      'gemini',
    ]);
    await composer.fill('@g');
    await composer.press('Tab');
    await expect(composer).toHaveValue('@gemini ');
    await composer.fill('@gemini Inspect this');
    await composer.press('Enter');
    await expect(page.locator('.streaming .message-heading strong')).toHaveText('gemini');
    await expect(page.locator('[data-message-id]')).toHaveCount(2);
    await expect(page.locator('[data-message-id="m1"] .message-route')).toHaveText('to @gemini');
    await expect(page.locator('[data-message-id="m1"] .delivery strong')).toHaveText('gemini');
    await expect(page.locator('[data-message-id="m2"] .message-heading strong')).toHaveText(
      'gemini',
    );
    expect((await state(page)).session.messages[1]!.author).toBe('gemini');
  } finally {
    rmSync(configPath);
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    await expect.poll(async () => (await state(page)).idle).toBe(true);
    await composer.fill('/reload');
    await composer.press('Enter');
    await expect(page.getByRole('group', { name: 'Participant astra', exact: true })).toHaveCount(
      0,
    );
    const restoredSettings = page
      .getByRole('group', { name: 'Participant codex', exact: true })
      .locator('dd');
    await expect(restoredSettings).toHaveCount(2);
    await expect(restoredSettings.nth(0)).toHaveText('provider default');
    await expect(restoredSettings.nth(1)).toHaveText('provider default');
  }
});

test('compacts context while paused and exposes the accepted checkpoint with sources', async ({
  page,
}) => {
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('/pause');
  await composer.press('Enter');
  await composer.fill('@codex Correction: ship Tuesday, replacing Monday.');
  await composer.press('Enter');
  await expect(page.locator('[data-message-id="m1"]')).toBeVisible();
  await page.getByRole('button', { name: 'Compact context for codex', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Optional focus instructions' })
    .fill('Remember the release correction');
  await page.getByRole('button', { name: 'Start compaction', exact: true }).click();
  await expect
    .poll(async () => (await state(page)).agents.find((a) => a.id === 'codex')?.maintenance?.status)
    .toBe('completed');
  const snapshot = await state(page);
  expect(snapshot.agents.find((a) => a.id === 'codex')?.maintenance?.instructions).toBe(
    'Remember the release correction',
  );
  await expect(
    page.getByText('custom focus unsupported; using default', { exact: false }),
  ).toBeVisible();
  expect(snapshot.session.paused).toBe(true);
  expect(snapshot.session.messages[0]?.deliveries.codex?.status).toBe('queued');
  await page.getByRole('button', { name: 'Checkpoint', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Version 1');
  await expect(dialog).toContainText('through #m1');
  await expect(dialog).toContainText('Correction: ship Tuesday, replacing Monday.');
  await expect(dialog).toContainText('#m1 @human');
  await page.screenshot({ path: '.local/web-checkpoint.png', fullPage: true });
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await composer.fill('/continue');
  await composer.press('Enter');
  await expect(page.locator('[data-message-id="m2"]')).toBeVisible();
  expect((await state(page)).session.messages.filter((m) => m.author === 'codex')).toHaveLength(1);
});

test('compacts all agents with a focus from the browser toolbar', async ({ page }) => {
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('/pause');
  await composer.press('Enter');
  await composer.fill('Epic 42 and ticket 17 remain the focus.');
  await composer.press('Enter');
  await expect(page.locator('[data-message-id="m1"]')).toBeVisible();
  await page.getByRole('button', { name: 'Compact all', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Optional focus instructions' })
    .fill('@claude raised a concern; remember the epic details');
  await page.getByRole('button', { name: 'Start compaction', exact: true }).click();
  await expect
    .poll(async () =>
      (await state(page)).agents.filter((a) => a.enabled).map((a) => a.maintenance?.status),
    )
    .toEqual(['completed', 'completed']);
  const snapshot = await state(page);
  expect(
    snapshot.agents
      .filter((a) => a.enabled)
      .every(
        (a) =>
          a.maintenance?.instructions === '@claude raised a concern; remember the epic details',
      ),
  ).toBe(true);
  expect(snapshot.session.paused).toBe(true);
  expect(snapshot.session.messages).toHaveLength(1);
});

test('persistent questions survive refresh and answer choices send literal replies once', async ({
  page,
}) => {
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('@claude [question]');
  await composer.press('Enter');
  await expect(
    page.getByRole('button', { name: 'Unanswered questions (1)', exact: true }),
  ).toBeVisible();
  const card = page.locator('[data-message-id="m2"]');
  await expect(card).toContainText('Awaiting your answer');
  await page.reload();
  await expect(card).toContainText('Awaiting your answer');
  await composer.fill('/pause');
  await composer.press('Enter');
  await expect.poll(async () => (await state(page)).session.paused).toBe(true);
  await composer.fill('Keep this unrelated draft');
  await page.getByRole('button', { name: 'Unanswered questions (1)', exact: true }).click();
  const inbox = page.getByRole('dialog', { name: 'Unanswered questions', exact: true });
  await expect(inbox).toContainText('Which implementation should we start with?');
  await page.screenshot({ path: '.local/questions-desktop.png', fullPage: true });
  // A second browser may be showing the same unanswered question.
  const second = await page.context().newPage();
  // Hold incoming snapshots while leaving the actual command transport connected.
  // This deterministically models a tab whose SSE update arrives after its submission.
  await second.addInitScript(() => {
    const fetchOriginal = window.fetch;
    let holding = true;
    const held: (() => void)[] = [];
    Object.assign(window, {
      releaseQuestionUpdates: () => {
        holding = false;
        held.splice(0).forEach((deliver) => deliver());
      },
    });
    window.fetch = async (...args) => {
      const response = await fetchOriginal(...args);
      if (!String(args[0]).endsWith('/api/events') || !response.body) return response;
      const stream = response.body.pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            if (holding) held.push(() => controller.enqueue(chunk));
            else controller.enqueue(chunk);
          },
        }),
      );
      return new Response(stream, { status: response.status, headers: response.headers });
    };
  });
  const { url } = JSON.parse(readFileSync('.local/web-fixture.json', 'utf8'));
  await second.goto(url);
  await expect(second.locator('[data-message-id="m2"]')).toContainText('Awaiting your answer');
  await inbox.getByRole('button', { name: '/pause @claude', exact: true }).click();
  await expect(inbox.getByRole('textbox', { name: 'Your answer to #m2' })).toHaveValue(
    '/pause @claude',
  );
  expect((await state(page)).session.messages).toHaveLength(2);
  await inbox.getByRole('button', { name: 'Send answer', exact: true }).click();
  await expect(inbox).toContainText('No unanswered questions.');
  await expect(composer).toHaveValue('Keep this unrelated draft');
  const staleCard = second.getByRole('group', { name: 'Question #m2', exact: true });
  await staleCard.getByRole('button', { name: 'Paste and send', exact: true }).click();
  await staleCard.getByRole('button', { name: 'Send answer', exact: true }).click();
  await expect(staleCard.getByRole('alert')).toHaveText('Question #m2 has already been answered');
  expect((await state(page)).session.messages).toHaveLength(3);
  await second.evaluate(() =>
    (window as unknown as { releaseQuestionUpdates: () => void }).releaseQuestionUpdates(),
  );
  await expect(staleCard).toContainText('Answered in #m3');
  await expect(staleCard.locator('.question-answer')).toHaveText('/pause @claude');
  const snapshot = await state(page);
  expect(
    snapshot.session.messages.filter((m) => m.replyTo.includes('m2') && m.author === 'human'),
  ).toHaveLength(1);
  expect(snapshot.session.messages.find((m) => m.id === 'm3')).toMatchObject({
    text: '/pause @claude',
    recipients: ['claude'],
    replyTo: ['m2'],
  });
  expect(snapshot.agents.find((a) => a.id === 'claude')!.paused).toBe(false);
  expect(snapshot.permissions).toEqual({ edits: false, commands: false, network: false });
  await second.close();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.reload();
  await expect(page.locator('[data-message-id="m2"]')).toContainText('Answered in #m3');
  await expect(
    page.getByRole('button', { name: 'Unanswered questions (0)', exact: true }),
  ).toBeVisible();
});

test('answers a persistent question with a saved inline draft on mobile', async ({ page }) => {
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('@claude [question]');
  await composer.press('Enter');
  const card = page.getByRole('group', { name: 'Question #m2', exact: true });
  await expect(card).toBeVisible();
  await page.setViewportSize({ width: 375, height: 844 });
  await composer.fill('Unrelated composer draft');
  await card.getByRole('button', { name: 'Write a different answer' }).click();
  await card.getByRole('textbox').fill('A third approach\nKeep it small');
  await page.getByRole('button', { name: 'Unanswered questions (1)', exact: true }).click();
  const inbox = page.getByRole('dialog', { name: 'Unanswered questions', exact: true });
  await expect(inbox.getByRole('textbox')).toHaveValue('A third approach\nKeep it small');
  await inbox.getByRole('textbox').fill('  A third approach\nKeep it small  ');
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await expect(card.getByRole('textbox')).toHaveValue('  A third approach\nKeep it small  ');
  await page.reload();
  await expect(card.getByRole('textbox')).toHaveValue('  A third approach\nKeep it small  ');
  await expect(composer).toHaveValue('Unrelated composer draft');
  await card.getByRole('button', { name: 'Send answer', exact: true }).click();
  await expect(card).toContainText('Answered in #m3');
  const snapshot = await state(page);
  expect(snapshot.session.messages.find((m) => m.id === 'm3')).toMatchObject({
    text: '  A third approach\nKeep it small  ',
    replyTo: ['m2'],
    recipients: ['claude'],
    finalAnswer: { questionId: 'm2' },
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.local/questions-mobile.png', fullPage: true });
});

for (const theme of ['light', 'dark'] as const)
  test(`question advice preserves drafts and supports keyboard, wrapping and contrast in ${theme}`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: theme });
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    await composer.fill('@claude [question]');
    await composer.press('Enter');
    const card = page.getByRole('group', { name: 'Question #m2', exact: true });
    await expect(card).toBeVisible();
    await expect(card.getByRole('button', { pressed: true })).toHaveCount(0);
    const choice = card.getByRole('button', { name: 'Probe first', exact: true });
    await choice.focus();
    await choice.press('Space');
    await expect(choice).toHaveAttribute('aria-pressed', 'true');
    await card.getByRole('textbox').fill('My independent draft');
    await card.getByRole('button', { name: 'Ask the room', exact: true }).click();
    await expect(card).toContainText('Advice from @claude');
    await expect(card).toContainText('Advice from @codex');
    await expect(card.getByRole('textbox')).toHaveValue('My independent draft');
    expect((await state(page)).session.messages.some((m) => m.finalAnswer)).toBe(false);
    const use = card
      .locator('.question-advice')
      .filter({ hasText: 'Advice from @codex' })
      .getByRole('button', { name: 'Use this answer' });
    await use.focus();
    await use.press('Enter');
    await expect(card.getByRole('textbox')).toHaveValue('Paste and send');
    await card.getByRole('textbox').fill('Edited recommendation');
    await page.route('**/api/command', (route) =>
      route.fulfill({ json: { ok: false, error: 'Test submission failed' } }),
    );
    await card.getByRole('button', { name: 'Send answer' }).click();
    await expect(card.getByRole('alert')).toHaveText('Test submission failed');
    await expect(card.getByRole('textbox')).toHaveValue('Edited recommendation');
    await page.unroute('**/api/command');
    const measure = async () =>
      card.evaluate((element) => {
        const rgb = (value: string) =>
          value
            .match(/\d+(?:\.\d+)?/g)!
            .slice(0, 3)
            .map(Number);
        const luminance = (value: string) =>
          rgb(value)
            .map((v) => v / 255)
            .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
            .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0);
        const contrast = (a: string, b: string) =>
          (Math.max(luminance(a), luminance(b)) + 0.05) /
          (Math.min(luminance(a), luminance(b)) + 0.05);
        const styles = getComputedStyle(element);
        const button = getComputedStyle(element.querySelector('button')!);
        return {
          text: contrast(styles.color, styles.backgroundColor),
          control: contrast(button.borderTopColor, styles.backgroundColor),
          focus: contrast(button.outlineColor, styles.backgroundColor),
          focusWidth: button.outlineWidth,
        };
      });
    await choice.focus();
    await choice.press('Tab');
    await choice.focus();
    const ratios = await measure();
    expect(ratios.text).toBeGreaterThanOrEqual(4.5);
    expect(ratios.control).toBeGreaterThanOrEqual(3);
    expect(ratios.focus).toBeGreaterThanOrEqual(3);
    expect(ratios.focusWidth).toBe('3px');
    console.log(theme, 'question contrast', JSON.stringify(ratios));
    await page.screenshot({ path: `.local/questions-${theme}-desktop.png`, fullPage: true });
    await page.setViewportSize({ width: 375, height: 844 });
    await expect(card.getByRole('button', { name: 'Send answer' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: `.local/questions-${theme}-375.png`, fullPage: true });
    await card.locator('.question-advice').last().scrollIntoViewIfNeeded();
    await page.screenshot({ path: `.local/questions-${theme}-375-advice.png`, fullPage: true });
    await card.getByRole('button', { name: 'Send answer' }).click();
    await expect(card).toContainText('Answered in');
    await expect(card).toContainText('Edited recommendation');
    await expect(card.getByRole('button', { name: 'Send answer' })).toHaveCount(0);
  });

test('free-text questions show input immediately and keep question drafts isolated between sessions', async ({
  page,
}) => {
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('@claude [free-question]');
  await composer.press('Enter');
  const card = page.getByRole('group', { name: 'Question #m2', exact: true });
  await expect(card.getByRole('textbox')).toBeVisible();
  await card.getByRole('textbox').fill('First room draft');
  await composer.fill('@claude [free-question]');
  await composer.press('Enter');
  await expect(
    page.getByRole('group', { name: 'Question #m4', exact: true }).getByRole('textbox'),
  ).toHaveValue('');
  const sessionId = (await state(page)).session.id;
  await page.getByRole('button', { name: 'New conversation', exact: false }).click();
  await composer.fill('@claude [free-question]');
  await composer.press('Enter');
  await expect(card.getByRole('textbox')).toHaveValue('');
  await composer.fill('/sessions ' + sessionId);
  await composer.press('Enter');
  await expect(card.getByRole('textbox')).toHaveValue('First room draft');
});

// These use C2's real raw upload, draft/command, authenticated image read and saved-session storage.
import {
  tinyPng,
  alternatePng,
  dimensionPng,
  interlacedPng,
  noisePng,
  solidPng,
  widePng,
} from '../image-fixture.js';
const imageFile = (name: string, buffer = tinyPng()) => ({ name, mimeType: 'image/png', buffer });
const imageInput = (page: Page) => page.getByLabel('Select images', { exact: true });
const draftImages = (page: Page) => page.locator('.draft-images');
const messageInput = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
async function loadedImages(page: Page, selector = '.draft-images img', count = 1) {
  await expect(page.locator(selector)).toHaveCount(count);
  await expect
    .poll(() =>
      page
        .locator(selector)
        .evaluateAll((nodes) => nodes.every((node) => (node as HTMLImageElement).naturalWidth > 0)),
    )
    .toBe(true);
}
async function transfer(page: Page, kind: 'paste' | 'drop', names: string[], text = '') {
  await page.evaluate(
    ({ kind, names, text, bytes }) => {
      const data = new DataTransfer();
      for (const name of names)
        data.items.add(new File([Uint8Array.from(bytes)], name, { type: 'image/png' }));
      data.setData('text/plain', text);
      if (kind === 'paste')
        document
          .querySelector('textarea[aria-label="Message"]')!
          .dispatchEvent(
            new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
          );
      else
        document
          .querySelector('.composer-box')!
          .dispatchEvent(
            new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }),
          );
    },
    { kind, names, text, bytes: [...tinyPng()] },
  );
}

test('images: paste, drop, selection, ordered captions and image-only reply semantics', async ({
  page,
}) => {
  const composer = messageInput(page);
  await composer.fill('@human Caption');
  await transfer(page, 'paste', ['paste.png'], 'alternative text must not be inserted');
  await loadedImages(page);
  await expect(composer).toHaveValue('@human Caption');
  await transfer(page, 'drop', ['drop.png']);
  await loadedImages(page, '.draft-images img', 2);
  await imageInput(page).setInputFiles(imageFile('selected.png'));
  await loadedImages(page, '.draft-images img', 3);
  await expect(page.locator('.image-status-warning')).toHaveCount(0);
  const ids = (await state(page)).session.composerAttachments.map((a) => a.id);
  await composer.press('Enter');
  await expect(composer).toHaveValue('');
  const sent = (await state(page)).session.messages[0]!;
  expect(sent.attachments?.map((a) => a.id)).toEqual(ids);
  expect(sent.text).toBe('Caption');
  expect(sent.recipients).toEqual(['human']);
  await loadedImages(page, '[data-message-id="m1"] img', 3);
  await page
    .locator('[data-message-id="m1"]')
    .getByRole('button', { name: 'Reply', exact: true })
    .click();
  await imageInput(page).setInputFiles(imageFile('reply.png', alternatePng()));
  await loadedImages(page);
  await expect(page.locator('.image-status-warning')).toHaveCount(0);
  await composer.press('Enter');
  await expect(page.locator('[data-message-id="m2"]')).toBeVisible();
  const reply = (await state(page)).session.messages[1]!;
  expect(reply.text).toBe('');
  expect(reply.replyTo).toEqual(['m1']);
  expect(reply.recipients).toEqual(['human']);
  await expect(
    page.locator('[data-message-id="m2"]').getByRole('button', { name: 'Copy message' }),
  ).toHaveCount(0);
  await page
    .locator('[data-message-id="m2"]')
    .getByRole('button', { name: 'Pin message', exact: true })
    .click();
  await page.getByRole('button', { name: /^Pinned messages/ }).click();
  await expect(page.getByRole('dialog')).toContainText('[Image: reply.png]');
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Copy message' })).toHaveCount(
    0,
  );
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page
    .locator('[data-message-id="m2"]')
    .getByRole('button', { name: 'Reply', exact: true })
    .click();
  await expect(page.getByRole('group', { name: 'Reply preview' })).toContainText(
    '[Image: reply.png]',
  );
  await composer.fill('@codex ');
  await imageInput(page).setInputFiles(imageFile('override.png'));
  await loadedImages(page);
  await composer.fill('@co');
  await expect(page.locator('.image-status-warning')).toHaveCount(0);
  await composer.fill('@codex ');
  await expect(page.locator('.image-status-warning')).toContainText("@codex can't receive images");
  await composer.press('Enter');
  await expect(page.locator('[data-message-id="m3"]')).toBeVisible();
  expect((await state(page)).session.messages[2]!.recipients).toEqual(['codex']);
  await expect(page.locator('[data-message-id="m3"]')).toContainText('failed');
  await expect(
    page.locator('.notice').filter({ hasText: 'image in #m3 was not delivered' }),
  ).toBeVisible();
});

test('images: rejection, removal and late out-of-order uploads preserve the caption and identities', async ({
  page,
}) => {
  const composer = messageInput(page);
  await composer.fill('@human Keep caption');
  const releases: Record<string, () => void> = {};
  await page.route('**/api/attachments?*', async (route) => {
    const name = new URL(route.request().url()).searchParams.get('filename')!;
    await new Promise<void>((resolve) => {
      releases[name] = resolve;
    });
    await route.continue();
  });
  await imageInput(page).setInputFiles([
    imageFile('first.png'),
    imageFile('second.png'),
    imageFile('removed.png'),
  ]);
  await expect.poll(() => Object.keys(releases).length).toBe(3);
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Remove image removed.png' }).click();
  releases['second.png']!();
  await loadedImages(page);
  releases['removed.png']!();
  releases['first.png']!();
  await loadedImages(page, '.draft-images img', 2);
  expect((await state(page)).session.composerAttachments.map((a) => a.filename)).toEqual([
    'first.png',
    'second.png',
  ]);
  await page.unroute('**/api/attachments?*');
  // A header without decodable pixels cannot be converted, so nothing is uploaded.
  await imageInput(page).setInputFiles(imageFile('too-wide.png', dimensionPng(4097, 1)));
  await expect(draftImages(page)).toContainText('This file could not be read as an image.');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Remove image too-wide.png' }).click();
  await imageInput(page).setInputFiles({
    name: 'no.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('no'),
  });
  await expect(draftImages(page)).toContainText('This file could not be read as an image.');
  await page.getByRole('button', { name: 'Remove image no.txt' }).click();
  await page.getByRole('button', { name: 'Remove image first.png' }).click();
  await loadedImages(page);
  await expect(composer).toHaveValue('@human Keep caption');
  await transfer(page, 'drop', [], 'https://example.com/image.png');
  await expect(page.getByRole('alert')).toContainText('URLs are not fetched');
  expect((await state(page)).session.composerAttachments.map((a) => a.filename)).toEqual([
    'second.png',
  ]);
  await composer.press('Enter');
  await expect(page.locator('[data-message-id="m1"]')).toBeVisible();
});

test('images: lost upload and send acknowledgements replay the same operations after reload', async ({
  page,
}) => {
  let uploadId = '';
  let uploadAttachment = '';
  let uploads = 0;
  await page.route('**/api/attachments?*', async (route) => {
    const id = new URL(route.request().url()).searchParams.get('operationId')!;
    if (uploads++) {
      expect(id).toBe(uploadId);
      await route.continue();
      return;
    }
    uploadId = id;
    const response = await route.fetch();
    uploadAttachment = (await response.json()).attachment.id;
    await route.abort('failed');
  });
  await messageInput(page).fill('@human Lost response');
  await imageInput(page).setInputFiles(imageFile('recover.png'));
  await expect(page.getByRole('button', { name: 'Retry upload recover.png' })).toBeVisible();
  await page.reload();
  await page.getByLabel('Reselect recover.png').setInputFiles(imageFile('recover.png'));
  await loadedImages(page);
  expect((await state(page)).session.composerAttachments[0]!.id).toBe(uploadAttachment);
  let sendId = '';
  let sends = 0;
  await page.route('**/api/command', async (route) => {
    const data = route.request().postDataJSON();
    if (!data.attachmentIds) {
      await route.continue();
      return;
    }
    if (sends++) {
      expect(data.id).toBe(sendId);
      await route.continue();
      return;
    }
    sendId = data.id;
    await route.fetch();
    await route.abort('failed');
  });
  await messageInput(page).press('Enter');
  await expect(page.getByRole('button', { name: 'Check last action' })).toBeVisible();
  await expect(messageInput(page)).toHaveValue('@human Lost response');
  await page.reload();
  await page.getByRole('button', { name: 'Check last action' }).click();
  await expect(messageInput(page)).toHaveValue('');
  const messages = (await state(page)).session.messages;
  expect(messages).toHaveLength(1);
  expect(messages[0]!.attachmentOperation?.id).toBe(sendId);
  expect(messages[0]!.attachments?.[0]?.id).toBe(uploadAttachment);
});

test('images: host references restore without tab cache and viewer remains bounded and session scoped', async ({
  page,
}) => {
  await messageInput(page).fill('@human Saved caption');
  await imageInput(page).setInputFiles([
    imageFile('black.png', widePng()),
    imageFile('red.png', alternatePng()),
  ]);
  await loadedImages(page, '.draft-images img', 2);
  await messageInput(page).press('Enter');
  await expect(messageInput(page)).toHaveValue('');
  const original = (await state(page)).session;
  await page
    .locator('[data-message-id="m1"]')
    .getByRole('button', { name: 'Reply', exact: true })
    .click();
  await messageInput(page).fill('Staged reply');
  await imageInput(page).setInputFiles(imageFile('draft.png'));
  await loadedImages(page);
  await expect
    .poll(async () => (await state(page)).session.composerDraft)
    .toContain('Staged reply');
  await page.evaluate(() => {
    for (const key of Object.keys(sessionStorage))
      if (key !== 'chittr:token') sessionStorage.removeItem(key);
  });
  await page.reload();
  await loadedImages(page);
  await expect(messageInput(page)).toHaveValue('Staged reply');
  await expect(page.getByRole('group', { name: 'Reply preview' })).toContainText('#m1');
  await page.screenshot({ path: '.local/images-desktop.png' });
  await page.getByRole('button', { name: 'View image red.png' }).click();
  await loadedImages(page, 'dialog img');
  expect(
    await page.locator('dialog img').evaluate((node) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(node as HTMLImageElement, 0, 0);
      return [...ctx.getImageData(0, 0, 1, 1).data];
    }),
  ).toEqual([255, 0, 0, 255]);
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'View image black.png' }).focus();
  await page.keyboard.press('Enter');
  await loadedImages(page, 'dialog img');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.local/images-mobile.png' });
  await page.getByRole('button', { name: 'Close dialog' }).press('Enter');
  expect(
    await page.locator('.message-images').evaluate((node) => node.getBoundingClientRect().height),
  ).toBeLessThan(220);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'New conversation', exact: false }).click();
  await expect(page.locator('[data-message-id]')).toHaveCount(0);
  await page.getByRole('button', { name: /Saved conversations/ }).click();
  await page.getByRole('dialog').getByRole('button').filter({ hasText: 'Saved caption' }).click();
  await loadedImages(page);
  await loadedImages(page, '[data-message-id="m1"] img', 2);
  expect((await state(page)).session.messages[0]!.attachments).toEqual(
    original.messages[0]!.attachments,
  );
});

async function restartFixture() {
  const old = JSON.parse(readFileSync('.local/web-fixture.json', 'utf8'));
  const runner = JSON.parse(readFileSync('.local/web-fixture-runner.json', 'utf8'));
  process.kill(runner.pid, 'SIGUSR2');
  await expect
    .poll(() => JSON.parse(readFileSync('.local/web-fixture.json', 'utf8')).pid)
    .not.toBe(old.pid);
  return JSON.parse(readFileSync('.local/web-fixture.json', 'utf8'));
}

test('images: real host restart restores accepted references and unknown send with new authentication', async ({
  page,
}) => {
  await messageInput(page).fill('@human Restart image');
  await imageInput(page).setInputFiles(imageFile('restart-red.png', alternatePng()));
  await loadedImages(page);
  let operationId = '';
  await page.route('**/api/command', async (route) => {
    const body = route.request().postDataJSON();
    if (body.attachmentIds) {
      operationId = body.id;
      await route.fetch();
      await route.abort('failed');
    } else await route.continue();
  });
  await messageInput(page).press('Enter');
  await expect(page.getByRole('button', { name: 'Check last action' })).toBeVisible();
  const old = await state(page);
  const next = await restartFixture();
  // Unreloaded old tab initiates a new read with its obsolete bearer token.
  await page.getByRole('button', { name: 'View image restart-red.png' }).click();
  await expect(page.getByRole('dialog')).toContainText('Image unavailable');
  await page.unroute('**/api/command');
  await page.goto(next.url);
  await page.reload();
  await page.getByRole('button', { name: 'Check last action' }).click();
  await expect(messageInput(page)).toHaveValue('');
  const restored = await state(page);
  expect(restored.instanceId).not.toBe(old.instanceId);
  expect(restored.session.id).toBe(old.session.id);
  expect(restored.session.messages).toHaveLength(1);
  expect(restored.session.messages[0]!.attachmentOperation!.id).toBe(operationId);
  expect(restored.session.messages[0]!.attachments).toEqual(old.session.messages[0]!.attachments);
  await imageInput(page).setInputFiles(imageFile('staged.png'));
  await messageInput(page).fill('Persistent draft');
  await loadedImages(page);
  await expect.poll(async () => (await state(page)).session.composerDraft).toBe('Persistent draft');
  const staged = (await state(page)).session.composerAttachments;
  const second = await restartFixture();
  await page.evaluate(() => {
    for (const key of Object.keys(sessionStorage))
      if (key !== 'chittr:token') sessionStorage.removeItem(key);
  });
  await page.goto(second.url);
  await page.reload();
  await loadedImages(page);
  await expect(messageInput(page)).toHaveValue('Persistent draft');
  expect((await state(page)).session.composerAttachments).toEqual(staged);
  await page.getByRole('button', { name: 'View image restart-red.png' }).click();
  await loadedImages(page, 'dialog img');
  expect(
    await page.locator('dialog img').evaluate((node) => {
      const c = document.createElement('canvas');
      c.width = c.height = 1;
      const x = c.getContext('2d')!;
      x.drawImage(node as HTMLImageElement, 0, 0);
      return [...x.getImageData(0, 0, 1, 1).data];
    }),
  ).toEqual([255, 0, 0, 255]);
});

test('images: stale ownership, definitive send failure and delayed work keep a recoverable current draft', async ({
  page,
}) => {
  const composer = messageInput(page);
  await composer.fill('@human Original caption');
  let conflict = true;
  await page.route('**/api/draft', async (route) => {
    const body = route.request().postDataJSON();
    if (conflict && body.attachmentIds?.length) {
      conflict = false;
      await page.request.post('/api/draft', {
        headers: await authHeaders(page),
        data: {
          sessionId: body.sessionId,
          clientId: crypto.randomUUID(),
          version: 1,
          text: 'Another client changed the draft',
        },
      });
    }
    await route.continue();
  });
  await imageInput(page).setInputFiles(imageFile('conflict.png'));
  await expect(page.getByRole('button', { name: 'Retry upload conflict.png' })).toBeVisible();
  await expect(composer).toHaveValue('@human Original caption');
  expect((await state(page)).session.composerAttachments).toEqual([]);
  await composer.fill('@human Newer caption');
  await page.getByRole('button', { name: 'Retry upload conflict.png' }).click();
  await loadedImages(page);
  await composer.fill('/pause');
  await composer.press('Escape');
  await composer.press('Enter');
  await expect(page.getByRole('alert')).toContainText('Attachments');
  await loadedImages(page);
  await expect(composer).toHaveValue('/pause');
  await composer.fill('@human Valid retry');
  await composer.press('Enter');
  await expect(composer).toHaveValue('');
  expect((await state(page)).session.messages).toHaveLength(1);
  let release: () => void = () => {};
  await page.route('**/api/attachments?*', async (route) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.continue();
  });
  await imageInput(page).setInputFiles(imageFile('late-session.png'));
  await expect(draftImages(page)).toContainText('Uploading');
  await page.getByRole('button', { name: 'New conversation', exact: false }).click();
  await expect(page.locator('[data-message-id]')).toHaveCount(0);
  await composer.fill('New session text');
  release();
  await expect(draftImages(page).locator('.image-tile')).toHaveCount(0);
  await expect(composer).toHaveValue('New session text');
  expect((await state(page)).session.composerAttachments).toEqual([]);
});

test('images: protected reads, corrupt and missing bytes show bounded retry UI without changing references', async ({
  page,
  context,
}) => {
  await messageInput(page).fill('@human Safe ![remote](https://example.com/private.png)');
  let remoteRequests = 0;
  await page.route('https://example.com/**', (route) => {
    remoteRequests++;
    return route.abort();
  });
  await imageInput(page).setInputFiles(imageFile('protected.png'));
  await loadedImages(page);
  await messageInput(page).press('Enter');
  await expect(messageInput(page)).toHaveValue('');
  const snapshot = await state(page);
  const reference = snapshot.session.messages[0]!.attachments![0]!;
  const imageUrl = `/api/attachments/${reference.id}?sessionId=${snapshot.session.id}`;
  await expect(page.locator('[data-message-id="m1"] img')).toHaveAttribute('src', /^blob:/);
  expect(remoteRequests).toBe(0);
  await expect(page.locator('.image-reference')).toHaveText('[Image: remote]');
  const response = await page.request.get(imageUrl, { headers: await authHeaders(page) });
  expect(response.headers()['content-security-policy']).toContain("img-src 'self'");
  expect(response.headers()['cache-control']).toBe('no-store');
  const persistence = await page.evaluate(() =>
    JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
  );
  expect(persistence).not.toMatch(/data:image|iVBORw0KGgo|"bytes"/);
  expect(JSON.stringify(snapshot)).not.toMatch(/data:image|iVBORw0KGgo|"bytes"/);
  expect((await context.cookies()).filter((cookie) => cookie.name.startsWith('chittr-'))).toEqual(
    [],
  );
  const token = await page.evaluate(() => {
    const saved = sessionStorage.getItem('chittr:token')!;
    sessionStorage.removeItem('chittr:token');
    return saved;
  });
  await page.getByRole('button', { name: 'View image protected.png' }).click();
  await expect(page.getByRole('dialog')).toContainText('Image unavailable');
  await page.evaluate((value) => sessionStorage.setItem('chittr:token', value), token);
  await page.getByRole('button', { name: 'Retry image protected.png' }).click();
  await loadedImages(page, 'dialog img');
  await page.keyboard.press('Escape');
  const fixture = JSON.parse(readFileSync('.local/web-fixture.json', 'utf8'));
  const index = JSON.parse(
    readFileSync(join(fixture.directory, snapshot.session.id, 'attachments/index.json'), 'utf8'),
  );
  const blob = join(
    fixture.directory,
    snapshot.session.id,
    'attachments/blobs',
    index.attachments[reference.id].sha256 + '.bin',
  );
  writeFileSync(blob, 'corrupt');
  await page.getByRole('button', { name: 'View image protected.png' }).click();
  await expect(page.getByRole('dialog')).toContainText('Image unavailable');
  expect((await state(page)).session.messages[0]!.attachments).toEqual([reference]);
  rmSync(blob);
  await page.getByRole('button', { name: 'Retry image protected.png' }).click();
  await expect(page.getByRole('dialog')).toContainText('Image unavailable');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /Quit/ }).click();
  await expect(page.getByText('Conversation saved.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'View image protected.png' }).click();
  await expect(page.getByRole('dialog')).toContainText('Image unavailable');
  // Restore a live fixture for the remaining suite; this is orchestration only.
  await restartFixture();
});

test('images: delayed thumbnails preserve following and history reading, keyboard controls stay reachable', async ({
  page,
}) => {
  const composer = messageInput(page);
  for (let i = 0; i < 12; i++) {
    await composer.fill(`@human History ${i}\n${'Line of text\n'.repeat(5)}`);
    await composer.press('Enter');
    await expect(composer).toHaveValue('');
  }
  await imageInput(page).setInputFiles([
    imageFile('one.png'),
    imageFile('two.png'),
    imageFile('three.png'),
    imageFile('four.png'),
  ]);
  await loadedImages(page, '.draft-images img', 4);
  await page.getByRole('button', { name: 'Remove image four.png' }).focus();
  await page.keyboard.press('Enter');
  await loadedImages(page, '.draft-images img', 3);
  let release: () => void = () => {};
  let arrivals = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/attachments/att-*', async (route) => {
    arrivals++;
    await gate;
    await route.continue();
  });
  await composer.fill('@human Delayed images');
  await composer.press('Enter');
  await expect(page.locator('[data-message-id="m13"]')).toBeVisible();
  await expect.poll(() => arrivals).toBe(3);
  const distance = () =>
    page
      .locator('.transcript')
      .evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop);
  await expect.poll(distance).toBeLessThan(3);
  release();
  await loadedImages(page, '[data-message-id="m13"] img', 3);
  await expect.poll(distance).toBeLessThan(3);
  await page.unroute('**/api/attachments/att-*');
  await page.locator('.transcript').evaluate((node) => {
    node.scrollTop = 0;
    node.dispatchEvent(new Event('scroll'));
  });
  await expect(page.getByRole('button', { name: /Jump to latest/ })).toBeVisible();
  const before = await page.locator('.transcript').evaluate((node) => node.scrollTop);
  // Force a late thumbnail reload while reading old messages.
  await page
    .locator('[data-message-id="m13"] img')
    .first()
    .evaluate((node) => {
      (node as HTMLImageElement).src += '&late=1';
    });
  await loadedImages(page, '[data-message-id="m13"] img', 3);
  expect(await page.locator('.transcript').evaluate((node) => node.scrollTop)).toBe(before);
  await page.getByRole('button', { name: 'Attach images', exact: true }).focus();
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('Enter');
  await (await chooser).setFiles(imageFile('keyboard.png'));
  await loadedImages(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Send', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-message-id="m14"]')).toBeVisible();
  await page.getByRole('button', { name: 'View image keyboard.png' }).focus();
  expect(
    await page
      .getByRole('button', { name: 'View image keyboard.png' })
      .evaluate((node) => getComputedStyle(node).outlineStyle),
  ).not.toBe('none');
  await page.keyboard.press('Enter');
  await loadedImages(page, 'dialog img');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('images: text-only paste remains text and byte limits leave explicit removable failures', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const text = 'https://example.com/image.png';
  await page.evaluate((value) => navigator.clipboard.writeText(value), text);
  await messageInput(page).focus();
  await page.keyboard.press('Meta+V');
  await expect(messageInput(page)).toHaveValue(text);
  await expect(draftImages(page).locator('.image-tile')).toHaveCount(0);
  // Three incompressible 1000 px PNGs pass through unchanged at about 2.6 MB each,
  // so only two fit the 6 MiB per-message limit.
  await imageInput(page).setInputFiles(
    [1, 2, 3].map((n) => imageFile(`large-${n}.png`, noisePng(1000, 760, n))),
  );
  await loadedImages(page, '.draft-images img', 2);
  await expect(draftImages(page)).toContainText('Images exceed the 6 MiB per-message limit.');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  const accepted = new Set((await state(page)).session.composerAttachments.map((a) => a.filename));
  const failed = ['large-1.png', 'large-2.png', 'large-3.png'].find((name) => !accepted.has(name))!;
  await page.getByRole('button', { name: `Remove image ${failed}` }).click();
  await messageInput(page).fill('@human Large set');
  await messageInput(page).press('Enter');
  await expect(messageInput(page)).toHaveValue('');
  expect((await state(page)).session.messages[0]!.attachments).toHaveLength(2);
});

test('images: delayed send acknowledgement preserves a newer accepted draft and closes views on session switch', async ({
  page,
}) => {
  await messageInput(page).fill('@human Sent draft');
  await imageInput(page).setInputFiles(imageFile('sent.png'));
  await loadedImages(page);
  let release: () => void = () => {};
  let committed = false;
  await page.route('**/api/command', async (route) => {
    if (!route.request().postDataJSON().attachmentIds) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    committed = true;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fulfill({ response });
  });
  await messageInput(page).press('Enter');
  await expect.poll(() => committed).toBe(true);
  const snapshot = await state(page);
  const upload = await page.request.post(
    `/api/attachments?${new URLSearchParams({ sessionId: snapshot.session.id, operationId: crypto.randomUUID(), filename: 'newer.png' })}`,
    {
      headers: { ...(await authHeaders(page)), 'Content-Type': 'image/png' },
      data: alternatePng(),
    },
  );
  const attachment = (await upload.json()).attachment;
  const saved = await page.request.post('/api/draft', {
    headers: await authHeaders(page),
    data: {
      sessionId: snapshot.session.id,
      clientId: crypto.randomUUID(),
      version: 1,
      baseRevision: snapshot.session.composerDraftRevision,
      text: 'Newer accepted caption',
      attachmentIds: [attachment.id],
    },
  });
  expect(saved.ok()).toBe(true);
  release();
  await expect(messageInput(page)).toHaveValue('Newer accepted caption');
  await loadedImages(page);
  await expect
    .poll(async () => (await state(page)).session.composerDraft)
    .toBe('Newer accepted caption');
  expect((await state(page)).session.composerAttachments).toEqual([attachment]);
  await page.getByRole('button', { name: 'View image sent.png' }).click();
  await loadedImages(page, 'dialog img');
  await page.request.post('/api/command', {
    headers: await authHeaders(page),
    data: { id: crypto.randomUUID(), sessionId: snapshot.session.id, line: '/new' },
  });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(messageInput(page)).toHaveValue('');
  await expect(draftImages(page).locator('.image-tile')).toHaveCount(0);
});

test('images: a lost send acknowledgement after a newer accepted draft retries with the same identity and keeps the newer draft', async ({
  page,
}) => {
  await messageInput(page).fill('@human Sent draft');
  await imageInput(page).setInputFiles(imageFile('sent.png'));
  await loadedImages(page);
  let release: () => void = () => {};
  let committed = false;
  let sendId = '';
  let sends = 0;
  await page.route('**/api/command', async (route) => {
    const data = route.request().postDataJSON();
    if (!data.attachmentIds) {
      await route.continue();
      return;
    }
    if (sends++) {
      expect(data.id).toBe(sendId);
      await route.continue();
      return;
    }
    // A commits on the host, then its acknowledgement is lost after B is accepted.
    sendId = data.id;
    await route.fetch();
    committed = true;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.abort('failed');
  });
  await messageInput(page).press('Enter');
  await expect.poll(() => committed).toBe(true);
  const snapshot = await state(page);
  const upload = await page.request.post(
    `/api/attachments?${new URLSearchParams({ sessionId: snapshot.session.id, operationId: crypto.randomUUID(), filename: 'newer.png' })}`,
    {
      headers: { ...(await authHeaders(page)), 'Content-Type': 'image/png' },
      data: alternatePng(),
    },
  );
  const attachment = (await upload.json()).attachment;
  const saved = await page.request.post('/api/draft', {
    headers: await authHeaders(page),
    data: {
      sessionId: snapshot.session.id,
      clientId: crypto.randomUUID(),
      version: 1,
      baseRevision: snapshot.session.composerDraftRevision,
      text: 'Newer accepted caption',
      attachmentIds: [attachment.id],
    },
  });
  expect(saved.ok()).toBe(true);
  release();
  await expect(page.getByRole('button', { name: 'Check last action' })).toBeVisible();
  await expect(page.locator('.pending-banner')).toContainText('Checking the result');
  await expect(messageInput(page)).toBeDisabled();
  await expect(messageInput(page)).toHaveValue('@human Sent draft');
  await page.getByRole('button', { name: 'Check last action' }).click();
  await expect(page.locator('.pending-banner')).toHaveCount(0);
  await expect(messageInput(page)).toHaveValue('Newer accepted caption');
  await expect(messageInput(page)).toBeEnabled();
  await loadedImages(page);
  expect(sends).toBe(2);
  const after = await state(page);
  expect(after.session.messages).toHaveLength(1);
  expect(after.session.messages[0]!.attachmentOperation?.id).toBe(sendId);
  expect(after.session.composerDraft).toBe('Newer accepted caption');
  expect(after.session.composerAttachments).toEqual([attachment]);
  await expect(draftImages(page).locator('.image-tile')).toHaveCount(1);
  await page.reload();
  await expect(messageInput(page)).toHaveValue('Newer accepted caption');
  await expect(page.getByRole('button', { name: 'Check last action' })).toHaveCount(0);
});

test('images: removing an upload during a lost ownership acknowledgement does not resurrect it', async ({
  page,
}) => {
  await messageInput(page).fill('@human Keep text');
  let release: () => void = () => {};
  let saving = false;
  await page.route('**/api/draft', async (route) => {
    if (route.request().postDataJSON().attachmentIds?.length && !saving) {
      saving = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await route.fetch();
      await route.abort('failed');
    } else await route.continue();
  });
  await imageInput(page).setInputFiles(imageFile('remove-race.png'));
  await expect.poll(() => saving).toBe(true);
  await page.getByRole('button', { name: 'Remove image remove-race.png' }).click();
  release();
  await expect
    .poll(async () => (await state(page)).session.composerDraftRevision)
    .toBeGreaterThan(1);
  await expect.poll(async () => (await state(page)).session.composerAttachments).toEqual([]);
  await expect(draftImages(page).locator('.image-tile')).toHaveCount(0);
  await expect(messageInput(page)).toHaveValue('@human Keep text');
});

test('images: real mixed clipboard paste suppresses alternate text and native text drops still edit', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const composer = messageInput(page);
  await composer.fill('@human Caption');
  await page.evaluate(
    async (bytes) => {
      await navigator.clipboard.write([
        new ClipboardItem({
          'image/png': new Blob([Uint8Array.from(bytes)], { type: 'image/png' }),
          'text/plain': new Blob(['ALTERNATE TEXT'], { type: 'text/plain' }),
        }),
      ]);
    },
    [...tinyPng()],
  );
  await composer.focus();
  await page.keyboard.press('Meta+V');
  await loadedImages(page);
  expect((await state(page)).session.composerAttachments).toHaveLength(1);
  await expect(composer).toHaveValue('@human Caption');
  await page.evaluate(() => {
    const source = document.createElement('div');
    source.id = 'drag-text';
    source.textContent = 'Drag caption';
    source.draggable = true;
    source.style.cssText =
      'position:fixed;top:5px;left:5px;z-index:1000;background:white;padding:8px';
    source.addEventListener('dragstart', (event) =>
      event.dataTransfer!.setData('text/plain', 'Dropped caption'),
    );
    document.body.append(source);
  });
  await composer.fill('');
  await page.locator('#drag-text').dragTo(composer);
  await expect(composer).toHaveValue('Dropped caption');
  const url = page.url();
  let remoteRequests = 0;
  await page.route('https://example.com/**', (route) => {
    remoteRequests++;
    return route.abort();
  });
  await page.evaluate(() => {
    document.querySelector('#drag-text')!.remove();
    const source = document.createElement('a');
    source.id = 'drag-url';
    source.href = 'https://example.com/image.png';
    source.textContent = 'Drag URL';
    source.draggable = true;
    source.style.cssText =
      'position:fixed;top:5px;left:5px;z-index:1000;background:white;padding:8px';
    document.body.append(source);
  });
  await page.locator('#drag-url').dragTo(page.locator('.composer-heading'));
  await expect(page.getByRole('alert')).toContainText('URLs are not fetched');
  expect(page.url()).toBe(url);
  expect(remoteRequests).toBe(0);
  await expect(composer).toHaveValue('Dropped caption');
  expect((await state(page)).session.composerAttachments).toHaveLength(1);
});

test('images: reconnect reconciles host ownership and removal retry repeats the failed action', async ({
  page,
  context,
}) => {
  await messageInput(page).fill('@human Sent before reconnect');
  await imageInput(page).setInputFiles(imageFile('sent-before.png'));
  await loadedImages(page);
  await messageInput(page).press('Enter');
  await expect(messageInput(page)).toHaveValue('');
  await imageInput(page).setInputFiles(imageFile('old-draft.png'));
  await loadedImages(page);
  const before = await state(page);
  await context.setOffline(true);
  await messageInput(page).fill('Offline caption');
  await expect(
    page.getByRole('status').filter({ hasText: 'Draft save or refresh could not be confirmed' }),
  ).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  const upload = await page.request.post(
    `/api/attachments?${new URLSearchParams({ sessionId: before.session.id, operationId: crypto.randomUUID(), filename: 'host-current.png' })}`,
    {
      headers: { ...(await authHeaders(page)), 'Content-Type': 'image/png' },
      data: alternatePng(),
    },
  );
  const attachment = (await upload.json()).attachment;
  const now = await state(page);
  await page.request.post('/api/draft', {
    headers: await authHeaders(page),
    data: {
      sessionId: now.session.id,
      clientId: crypto.randomUUID(),
      version: 1,
      text: 'Other client',
      baseRevision: now.session.composerDraftRevision,
      attachmentIds: [attachment.id],
    },
  });
  await context.setOffline(false);
  await expect(draftImages(page).locator('[data-attachment-id]')).toHaveAttribute(
    'data-attachment-id',
    attachment.id,
  );
  await loadedImages(page);
  await loadedImages(page, '[data-message-id="m1"] img');
  await expect(messageInput(page)).toHaveValue('Offline caption');
  await page.getByRole('button', { name: 'Retry draft save', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Draft save or refresh could not be confirmed' }),
  ).toHaveCount(0);
  let removals = 0;
  await page.route('**/api/draft', async (route) => {
    if (route.request().postDataJSON().attachmentIds?.length === 0 && removals++ === 0)
      await route.abort('failed');
    else await route.continue();
  });
  await page.getByRole('button', { name: 'Remove image host-current.png' }).click();
  await expect(page.getByRole('alert')).toContainText('Image removal was not confirmed');
  await page.getByRole('button', { name: 'Retry image removal' }).click();
  await expect(draftImages(page).locator('.image-tile')).toHaveCount(0);
  expect((await state(page)).session.composerAttachments).toEqual([]);
  expect((await state(page)).session.messages[0]!.attachments).toEqual(
    before.session.messages[0]!.attachments,
  );
  expect(removals).toBe(2);
});

/** Bytes the host stored for an accepted attachment. */
async function hostBytes(page: Page, id: string): Promise<Buffer> {
  const sessionId = (await state(page)).session.id;
  const response = await page.request.get(`/api/attachments/${id}?sessionId=${sessionId}`, {
    headers: await authHeaders(page),
  });
  expect(response.ok()).toBe(true);
  return response.body();
}
/** A real JPEG from the browser's own encoder. */
async function jpeg(page: Page, width: number, height: number): Promise<Buffer> {
  const bytes = await page.evaluate(
    async ({ width, height }) => {
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#3a6';
      context.fillRect(0, 0, width, height);
      context.fillStyle = '#c33';
      context.fillRect(width / 4, height / 4, width / 2, height / 2);
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
      return [...new Uint8Array(await blob.arrayBuffer())];
    },
    { width, height },
  );
  return Buffer.from(bytes);
}
const attachmentNamed = async (page: Page, filename: string) =>
  (await state(page)).session.composerAttachments.find((a) => a.filename === filename);

test('images: the browser converts and shrinks images and passes host-ready PNGs through unchanged', async ({
  page,
}) => {
  const uploads: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/attachments?'))
      uploads.push(new URL(request.url()).searchParams.get('filename')!);
  });
  await messageInput(page).fill('@human Converted');
  const photo = await jpeg(page, 3000, 2000);
  await imageInput(page).setInputFiles({
    name: 'photo.jpg',
    mimeType: 'image/jpeg',
    buffer: photo,
  });
  await expect.poll(() => attachmentNamed(page, 'photo.png')).toBeDefined();
  expect(await attachmentNamed(page, 'photo.png')).toMatchObject({
    mediaType: 'image/png',
    width: 2000,
    height: 1333,
  });
  await imageInput(page).setInputFiles(imageFile('wide.png', solidPng(3000, 100)));
  await expect
    .poll(() => attachmentNamed(page, 'wide.png'))
    .toMatchObject({
      width: 2000,
      height: 67,
    });
  const ready = solidPng(1200, 800);
  await imageInput(page).setInputFiles(imageFile('ready.png', ready));
  await expect.poll(() => attachmentNamed(page, 'ready.png')).toBeDefined();
  const passed = (await attachmentNamed(page, 'ready.png'))!;
  expect(passed).toMatchObject({ width: 1200, height: 800, byteSize: ready.length });
  expect((await hostBytes(page, passed.id)).equals(ready)).toBe(true);
  await imageInput(page).setInputFiles(imageFile('interlaced.png', interlacedPng()));
  await expect.poll(() => attachmentNamed(page, 'interlaced.png')).toBeDefined();
  const reencoded = (await attachmentNamed(page, 'interlaced.png'))!;
  expect(reencoded).toMatchObject({ width: 1, height: 1, mediaType: 'image/png' });
  expect((await hostBytes(page, reencoded.id))[28]).toBe(0);
  const noise = noisePng(2000, 1500);
  expect(noise.length).toBeGreaterThan(3 * 1024 * 1024);
  await imageInput(page).setInputFiles(imageFile('noise.png', noise));
  await expect.poll(() => attachmentNamed(page, 'noise.png'), { timeout: 20000 }).toBeDefined();
  const shrunk = (await attachmentNamed(page, 'noise.png'))!;
  expect(shrunk.byteSize).toBeLessThanOrEqual(3 * 1024 * 1024);
  expect(shrunk.width).toBeLessThan(2000);
  await loadedImages(page, '.draft-images img', 5);
  const before = uploads.length;
  await imageInput(page).setInputFiles({
    name: 'broken.png',
    mimeType: 'image/png',
    buffer: Buffer.from('not an image'),
  });
  await expect(draftImages(page)).toContainText('This file could not be read as an image.');
  expect(uploads.length).toBe(before);
  expect(uploads).not.toContain('broken.png');
  await page.getByRole('button', { name: 'Remove image broken.png' }).click();
  await messageInput(page).press('Enter');
  await expect(messageInput(page)).toHaveValue('');
  expect((await state(page)).session.messages[0]!.attachments!.map((a) => a.filename)).toEqual([
    'photo.png',
    'wide.png',
    'ready.png',
    'interlaced.png',
    'noise.png',
  ]);
});

test('images: an in-page retry sends the same converted bytes under the same operation', async ({
  page,
}) => {
  const attempts: { operationId: string; body: Buffer }[] = [];
  await page.route('**/api/attachments?*', async (route) => {
    attempts.push({
      operationId: new URL(route.request().url()).searchParams.get('operationId')!,
      body: route.request().postDataBuffer()!,
    });
    if (attempts.length === 1) await route.abort('failed');
    else await route.continue();
  });
  await messageInput(page).fill('@human Retry');
  await imageInput(page).setInputFiles({
    name: 'retry.jpg',
    mimeType: 'image/jpeg',
    buffer: await jpeg(page, 640, 480),
  });
  await page.getByRole('button', { name: 'Retry upload retry.png' }).click();
  await loadedImages(page);
  expect(attempts).toHaveLength(2);
  expect(attempts[1]!.operationId).toBe(attempts[0]!.operationId);
  expect(attempts[1]!.body.equals(attempts[0]!.body)).toBe(true);
  expect(attempts[0]!.body.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
});

test('images: selecting 20 images at once stages all 20 in selection order', async ({ page }) => {
  const names = Array.from(
    { length: 20 },
    (_, index) => `image-${String(index).padStart(2, '0')}.png`,
  );
  await messageInput(page).fill('@human Twenty');
  await imageInput(page).setInputFiles(
    names.map((name, index) => imageFile(name, index % 2 ? alternatePng() : tinyPng())),
  );
  await loadedImages(page, '.draft-images img', 20);
  expect((await state(page)).session.composerAttachments.map((a) => a.filename)).toEqual(names);
  await messageInput(page).press('Enter');
  await expect(messageInput(page)).toHaveValue('');
  expect((await state(page)).session.messages[0]!.attachments).toHaveLength(20);
});

for (const kind of ['JPEG', 'downscaled PNG'] as const)
  test(`images: a lost upload acknowledgement for a ${kind} recovers the same operation after reload`, async ({
    page,
  }) => {
    const source =
      kind === 'JPEG'
        ? { name: 'lost.jpg', mimeType: 'image/jpeg', buffer: await jpeg(page, 2400, 1600) }
        : imageFile('lost.png', solidPng(3000, 200));
    let operationId = '';
    let attachmentId = '';
    const statuses: number[] = [];
    await page.route('**/api/attachments?*', async (route) => {
      const id = new URL(route.request().url()).searchParams.get('operationId')!;
      if (!operationId) {
        operationId = id;
        const response = await route.fetch();
        attachmentId = (await response.json()).attachment.id;
        await route.abort('failed');
        return;
      }
      expect(id).toBe(operationId);
      const response = await route.fetch();
      statuses.push(response.status());
      await route.fulfill({ response });
    });
    await messageInput(page).fill('@human Lost conversion');
    await imageInput(page).setInputFiles(source);
    await expect(page.getByRole('button', { name: 'Retry upload lost.png' })).toBeVisible();
    await page.reload();
    await page.getByLabel(`Reselect ${source.name}`).setInputFiles(source);
    await loadedImages(page);
    const accepted = (await state(page)).session.composerAttachments;
    expect(accepted.map((a) => a.id)).toEqual([attachmentId]);
    expect(accepted[0]).toMatchObject({ filename: 'lost.png', mediaType: 'image/png' });
    expect(Math.max(accepted[0]!.width, accepted[0]!.height)).toBeLessThanOrEqual(2000);
    // The retry replayed the original operation: no changed-input conflict, no new operation.
    expect(statuses).toEqual([201]);
  });

test('images: staged warnings show one line per affected recipient with collapsed details', async ({
  page,
}) => {
  const composer = messageInput(page);
  const warning = page.locator('.image-status-warning');
  await composer.fill('@claude ');
  await imageInput(page).setInputFiles(imageFile('status.png'));
  await loadedImages(page);
  // Every recipient can take images: no warning at all.
  await expect(warning).toHaveCount(0);
  await composer.fill('@claude @codex compare');
  await expect(warning).toHaveCount(1);
  await expect(warning).toHaveAttribute('role', 'status');
  await expect(warning.locator(':scope > div')).toHaveText(["@codex can't receive images"]);
  const reason = warning.getByText('@codex: no initial-image route is enabled for @codex');
  await expect(reason).toBeHidden();
  await warning.getByText('Details', { exact: true }).click();
  await expect(reason).toBeVisible();
  // A broadcast resolves to every enabled agent; only the affected one is listed.
  await composer.fill('Everyone');
  await expect(warning.locator(':scope > div')).toHaveText(["@codex can't receive images"]);
  await composer.fill('@human only');
  await expect(warning).toHaveCount(0);
  await expect(page.locator('.agent-image-status, .participant-image-reason')).toHaveCount(0);
  await expect(page.locator('.sidebar')).not.toContainText('Initial images');
});
