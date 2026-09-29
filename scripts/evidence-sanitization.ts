import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// #57 retained-evidence check. Evidence may hold identities, hashes, sizes and
// outcomes. It may not hold image bytes, a private visual answer, a secret, a
// private host path or a provider transcript, in a string or in any structure.
// Each rule names what it found and never echoes the matched content, so a
// finding cannot itself leak it.
const colorName = '(?:red|green|blue|yellow|cyan|purple|black|white)';
const rules: [string, RegExp][] = [
  ['PNG base64 payload', /iVBOR/],
  ['data URL', /data:[a-z]+\/[a-z0-9.+-]+;base64,/i],
  // A sha256 is 64 hex characters; nothing legitimate is a 200-character base64 run.
  ['long base64 run', /[A-Za-z0-9+/]{200,}={0,2}/],
  // The visual answers are unspaced color lists; the public question spaces its vocabulary.
  ['private visual answer', new RegExp(`\\b${colorName}(?:,${colorName}){2,}\\b`)],
  ['private host path', /(?:\/Users\/|\/home\/|\/private\/tmp\/|\/var\/folders\/)[^\s"']/],
  [
    'credential',
    /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xai-[A-Za-z0-9]{20,})|Bearer\s+[A-Za-z0-9._-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  ],
];
/** Longest string a sanitized boundary record needs; a reason or policy sentence fits. */
export const longestEvidenceString = 1200;
/** No boundary record needs a run of numbers this long; serialized bytes always do. */
export const longestNumberRun = 32;

const isByte = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255;
/** A conversation turn, however the provider spells it: who spoke, and what they said. */
function isTranscriptTurn(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const turn = value as Record<string, unknown>;
  const speaker = ['role', 'speaker', 'sender'].some((key) => typeof turn[key] === 'string');
  const said = ['content', 'text', 'message', 'parts'].some(
    (key) => typeof turn[key] === 'string' || Array.isArray(turn[key]),
  );
  return speaker && said;
}

function scan(value: unknown, path: string, findings: string[]) {
  if (typeof value === 'string') {
    for (const [name, pattern] of rules) if (pattern.test(value)) findings.push(`${path}: ${name}`);
    if (value.length > longestEvidenceString)
      findings.push(`${path}: oversized text, possibly a transcript`);
  } else if (Array.isArray(value)) {
    // Bytes survive JSON as numbers: a serialized Buffer, a typed array, a pixel row.
    if (value.length > longestNumberRun && value.every(isByte))
      findings.push(`${path}: byte array`);
    // Short turns add up to a transcript even when no single string is long.
    if (value.filter(isTranscriptTurn).length >= 2)
      findings.push(`${path}: provider transcript structure`);
    value.forEach((item, i) => scan(item, `${path}[${i}]`, findings));
  } else if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (record.type === 'Buffer' && Array.isArray(record.data))
      findings.push(`${path}: serialized Buffer`);
    if (isTranscriptTurn(value)) findings.push(`${path}: provider transcript turn`);
    for (const [key, item] of Object.entries(record)) scan(item, `${path}.${key}`, findings);
  }
}

function parse(text: string): unknown[] | undefined {
  try {
    return [JSON.parse(text)];
  } catch {
    // JSONL, the usual shape of a provider session file: every line its own document.
    const lines = text.split('\n').filter((line) => line.trim());
    try {
      return lines.length > 1 ? lines.map((line) => JSON.parse(line)) : undefined;
    } catch {
      return undefined;
    }
  }
}

/** Returns byte-free findings such as `$.initial.tuple: private host path`. */
export function evidenceFindings(text: string): string[] {
  const findings: string[] = [];
  const documents = parse(text);
  if (documents)
    documents.forEach((document, i) =>
      scan(document, documents.length > 1 ? `$[line ${i + 1}]` : '$', findings),
    );
  else {
    // Plain text is scanned line by line, under the same length bound as any string.
    text.split('\n').forEach((line, i) => scan(line, `$[line ${i + 1}]`, findings));
  }
  return findings;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const files = process.argv.slice(2);
  if (!files.length) throw new Error('Usage: evidence-sanitization.ts <evidence-file>...');
  let failed = false;
  for (const file of files) {
    const findings = evidenceFindings(readFileSync(file, 'utf8'));
    failed ||= findings.length > 0;
    console.log(`${findings.length ? 'FAIL' : 'PASS'} ${file}`);
    for (const finding of findings) console.log(`  ${finding}`);
  }
  if (failed) process.exitCode = 1;
}
