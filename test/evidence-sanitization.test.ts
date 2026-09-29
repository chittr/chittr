import { expect, it } from 'vitest';
import { evidenceFindings, longestEvidenceString } from '../scripts/evidence-sanitization.js';

const clean = {
  issue: 57,
  initial: {
    passed: true,
    providerSessionId: '019d1c5e-5b1c-7a41-9d0e-0a6f5f1c2b3d',
    attachmentId: 'att-0123456789abcdef0123456789abcdef',
    sha256: 'a'.repeat(64),
    byteSize: 1289,
  },
  // The public question spaces its color vocabulary, which is not an answer.
  note: 'Use each exact color name from red, green, blue, yellow, cyan, purple, black, white.',
  support: { reason: 'antigravity image support is unavailable: no accepted native mapping' },
};

it('passes identities, hashes, sizes, reasons and the spaced public vocabulary', () => {
  expect(evidenceFindings(JSON.stringify(clean))).toEqual([]);
});

it('names each kind of retained private content at its path without echoing it', () => {
  const secret = 'ghp_' + 'A1b2C3d4E5'.repeat(4);
  const cases: [string, unknown, string][] = [
    ['png', 'iVBORw0KGgoAAAANSUhEUgAA', 'PNG base64 payload'],
    ['url', 'data:image/png;base64,AAAA', 'data URL'],
    ['run', 'Q'.repeat(240), 'long base64 run'],
    ['whole', 'cyan,red,white,black,green,blue,purple,yellow', 'private visual answer'],
    ['region', 'reply was purple,black,red', 'private visual answer'],
    ['home', 'cwd /Users/someone/Projects/room', 'private host path'],
    ['scratch', '/private/tmp/chittr-integrated-live-abc/evidence.json', 'private host path'],
    ['token', `Authorization: ${secret}`, 'credential'],
    ['bearer', 'Bearer abcdefghijklmnopqrstuvwxyz012345', 'credential'],
    [
      'transcript',
      'word '.repeat(longestEvidenceString / 4),
      'oversized text, possibly a transcript',
    ],
  ];
  for (const [key, value, finding] of cases) {
    const findings = evidenceFindings(JSON.stringify({ ...clean, nested: [{ [key]: value }] }));
    expect(findings, key).toContain(`$.nested[0].${key}: ${finding}`);
    // A finding is safe to print and retain: it never carries the matched content.
    for (const line of findings) expect(line, key).not.toContain(String(value).slice(0, 12));
  }
});

it('does not mistake two colors, hashes or attachment identities for private content', () => {
  for (const value of ['red,green', 'f'.repeat(64), 'att-' + '0f'.repeat(16), 'm12', 'grok-4.6'])
    expect(evidenceFindings(JSON.stringify({ value })), value).toEqual([]);
});

it('rejects image bytes and transcripts held in structures rather than strings', () => {
  const png = [137, 80, 78, 71, 13, 10, 26, 10, ...Array.from({ length: 60 }, (_, i) => i)];
  const structured: [string, unknown, string][] = [
    // JSON.stringify(Buffer) keeps every byte as a number and no telltale string.
    ['buffer', JSON.parse(JSON.stringify(Buffer.from(png))), '$.held.buffer: serialized Buffer'],
    ['typed', png, '$.held.typed: byte array'],
    // Every turn is short and matches no pattern; together they are the conversation.
    [
      'turns',
      Array.from({ length: 12 }, (_, i) => ({
        role: i % 2 ? 'assistant' : 'user',
        content: `Turn ${i} of an ordinary exchange.`,
      })),
      '$.held.turns: provider transcript structure',
    ],
    [
      'parts',
      [
        { role: 'user', parts: [{ text: 'What is in the image?' }] },
        { role: 'model', parts: [{ text: 'Eight panels.' }] },
      ],
      '$.held.parts: provider transcript structure',
    ],
    [
      'turn',
      { role: 'assistant', content: 'A single retained reply.' },
      '$.held.turn: provider transcript turn',
    ],
  ];
  for (const [key, value, finding] of structured)
    expect(evidenceFindings(JSON.stringify({ ...clean, held: { [key]: value } })), key).toContain(
      finding,
    );
  // A provider session file is JSONL: no single JSON document, every line a short turn.
  const jsonl = Array.from({ length: 6 }, (_, i) =>
    JSON.stringify({ role: i % 2 ? 'assistant' : 'user', content: `Line ${i}.` }),
  ).join('\n');
  expect(evidenceFindings(jsonl)).toEqual(
    Array.from({ length: 6 }, (_, i) => `$[line ${i + 1}]: provider transcript turn`),
  );
  // Plain text is held to the same length bound as any string.
  expect(evidenceFindings(`notes\n${'word '.repeat(longestEvidenceString / 4)}`)).toEqual([
    '$[line 2]: oversized text, possibly a transcript',
  ]);
});

it('leaves ordinary numbers, sizes and role-less records alone', () => {
  for (const value of [
    [32, 120, 0, 0],
    { frameBytes: 1289, width: 648, height: 160, images: [{ byteSize: 1289 }] },
    Array.from({ length: 200 }, (_, i) => 1000 + i),
    [{ id: 'n1', text: 'antigravity: image in #m5 was not delivered' }],
    { role: 'unsupported mixed recipient', connection: 'unavailable' },
  ])
    expect(evidenceFindings(JSON.stringify({ value })), JSON.stringify(value).slice(0, 40)).toEqual(
      [],
    );
});

it('scans evidence that is not JSON line by line', () => {
  expect(evidenceFindings('run ok')).toEqual([]);
  expect(evidenceFindings('saved under /Users/someone/run.md')).toEqual([
    '$[line 1]: private host path',
  ]);
});
