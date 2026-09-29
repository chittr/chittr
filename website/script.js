// Hero transcript: a scripted room exchange that plays once, then offers replay.
(() => {
  const transcript = document.getElementById('transcript');
  const draft = document.getElementById('draft');
  const strip = document.getElementById('strip');
  const replay = document.getElementById('replay');
  const dividerLabel = document.getElementById('divider-label');
  if (!transcript) return;

  const reduced =
    window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
    new URLSearchParams(location.search).has('instant');
  let run = 0;

  const wait = (ms) => new Promise((r) => setTimeout(r, reduced ? 0 : ms));

  function setState(agent, state, busy) {
    const el = strip.querySelector(`[data-agent="${agent}"]`);
    if (!el) return;
    el.querySelector('i').textContent = state;
    el.classList.toggle('busy', Boolean(busy));
  }

  function message({ author, id, to = [], replyTo = [], text }) {
    const el = document.createElement('div');
    el.className = 'msg';
    el.dataset.agent = author === 'Bill' ? 'human' : author;
    const head = document.createElement('div');
    head.className = 'head';
    head.textContent =
      `${author}  #${id}` +
      (to.length ? '  → ' + to.map((n) => '@' + n).join(' ') : '') +
      (replyTo.length ? '  ↳ ' + replyTo.map((r) => '#' + r).join(', ') : '');
    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = text;
    const deliv = document.createElement('div');
    deliv.className = 'deliv';
    el.append(head, body, deliv);
    transcript.append(el);
    return { el, body, deliv };
  }

  function delivery(msg, entries) {
    msg.deliv.replaceChildren();
    for (const [agent, status, rationale] of entries) {
      const span = document.createElement('span');
      span.dataset.agent = agent;
      const b = document.createElement('b');
      b.textContent = agent;
      span.append(b, `: ${status}`);
      if (rationale) span.append(` · ${rationale}`);
      msg.deliv.append(span);
    }
  }

  // Time-based so a throttled background tab catches up instead of crawling.
  async function reveal(el, units, perUnit) {
    if (reduced) {
      el.textContent = units.join('');
      return;
    }
    el.textContent = '';
    const start = performance.now();
    let shown = 0;
    while (shown < units.length) {
      await wait(perUnit);
      const due = Math.min(units.length, Math.floor((performance.now() - start) / perUnit));
      if (due > shown) {
        el.textContent = units.slice(0, due).join('');
        shown = due;
      }
    }
  }

  async function typeInto(el, text, perChar = 28) {
    await reveal(el, [...text], perChar);
  }

  async function stream(msg, text, perWord = 60) {
    msg.el.classList.add('streaming');
    await reveal(msg.body, text.split(/(?<=\s)/), perWord);
    msg.el.classList.remove('streaming');
  }

  async function play() {
    const mine = ++run;
    const alive = () => mine === run;
    transcript.replaceChildren();
    draft.textContent = '';
    replay.hidden = true;
    dividerLabel.textContent = 'Latest';
    for (const a of ['codex', 'claude', 'grok']) setState(a, 'available', false);

    await wait(600);
    if (!alive()) return;
    await typeInto(
      draft,
      '@codex @claude Is the workspace lock safe if two terminals resume the same session?',
    );
    await wait(500);
    if (!alive()) return;
    draft.textContent = '';

    const m1 = message({
      author: 'Bill',
      id: 'm1',
      to: ['codex', 'claude'],
      text: 'Is the workspace lock safe if two terminals resume the same session?',
    });
    delivery(m1, [
      ['codex', 'sent'],
      ['claude', 'sent'],
    ]);
    setState('codex', 'considering', true);
    setState('claude', 'considering', true);
    await wait(700);
    if (!alive()) return;
    delivery(m1, [
      ['codex', 'received'],
      ['claude', 'received'],
    ]);
    await wait(1400);
    if (!alive()) return;

    setState('codex', 'replying', true);
    const m2 = message({ author: 'codex', id: 'm2', to: ['grok'], replyTo: ['m1'], text: '' });
    const codexText =
      'The store takes an exclusive lock per workspace, so a second resume fails fast with the ' +
      "holder's PID instead of racing snapshots. See src/store.ts.\n\n" +
      '@grok can you confirm the real-path check covers a symlinked --state-dir?';
    const streaming = stream(m2, codexText);

    await wait(1800);
    if (!alive()) return;
    delivery(m1, [
      ['codex', 'received'],
      ['claude', 'passed', 'codex is covering the lock; nothing to add'],
    ]);
    setState('claude', 'available', false);

    await streaming;
    if (!alive()) return;
    delivery(m1, [
      ['codex', 'contributed'],
      ['claude', 'passed', 'codex is covering the lock; nothing to add'],
    ]);
    delivery(m2, [['grok', 'queued']]);
    setState('codex', 'available', false);
    await wait(500);
    if (!alive()) return;
    delivery(m2, [['grok', 'received']]);
    setState('grok', 'considering', true);
    await wait(1300);
    if (!alive()) return;

    setState('grok', 'replying', true);
    const m3 = message({ author: 'grok', id: 'm3', replyTo: ['m2'], text: '' });
    await stream(
      m3,
      'Confirmed. The file worker resolves real paths before the lexical check, so a symlinked ' +
        'state dir stays inside the boundary. Nothing for Bill to change.',
    );
    if (!alive()) return;
    delivery(m2, [['grok', 'contributed']]);
    setState('grok', 'available', false);
    dividerLabel.textContent = 'Latest · exchange #m1 · 2 of 8 follow-up turns used';
    await wait(300);
    replay.hidden = false;
  }

  replay.addEventListener('click', play);

  if ('IntersectionObserver' in window && !reduced) {
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          play();
        }
      },
      { threshold: 0.35 },
    );
    io.observe(transcript.closest('.term'));
  } else {
    play();
  }
})();

// Copy buttons
for (const block of document.querySelectorAll('[data-copy]')) {
  const button = block.querySelector('.copy');
  const code = block.querySelector('code');
  if (!button || !code) continue;
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(code.textContent.trim());
      button.textContent = 'Copied';
      button.classList.add('done');
    } catch {
      button.textContent = 'Select and copy';
    }
    setTimeout(() => {
      button.textContent = 'Copy';
      button.classList.remove('done');
    }, 1600);
  });
}
