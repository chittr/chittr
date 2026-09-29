import { createHash, randomInt } from 'node:crypto';
import { deflateSync } from 'node:zlib';

// #57 mixed-recipient private oracle. One PNG is sent to every recipient, so a
// single whole-image question would let the first public reply answer for the
// rest. Each supported recipient is instead asked about its own disjoint run of
// panels, and the region answers are pairwise distinct, so under whole-field
// equality no recipient's public reply can satisfy another recipient's assertion.
// Nothing here is written to disk by this module; callers keep answers in memory.
export const panelColors = [
  ['red', [255, 0, 0]],
  ['green', [0, 160, 0]],
  ['blue', [0, 0, 255]],
  ['yellow', [255, 255, 0]],
  ['cyan', [0, 255, 255]],
  ['purple', [128, 0, 128]],
  ['black', [0, 0, 0]],
  ['white', [255, 255, 255]],
] as const;
export const panelsPerRecipient = 3;
const panelWidth = 72;
const height = 160;

export interface OracleRegion {
  /** One-based inclusive panel positions, counted from the left. */
  from: number;
  to: number;
  answer: string;
}
export interface RegionFixture {
  png: Buffer;
  sha256: string;
  byteSize: number;
  width: number;
  height: number;
  panelCount: number;
  regions: Record<string, OracleRegion>;
}

function crc32(data: Buffer) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data = Buffer.alloc(0)) {
  const name = Buffer.from(type);
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length);
  name.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return out;
}
export function panelPng(panels: readonly (readonly [number, number, number])[]) {
  const width = panels.length * panelWidth;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const raster = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      raster.set(panels[Math.floor(x / panelWidth)]!, y * (width * 3 + 1) + 1 + x * 3);
  return {
    width,
    height,
    png: Buffer.concat([
      Buffer.from('89504e470d0a1a0a', 'hex'),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(raster)),
      chunk('IEND'),
    ]),
  };
}

/** `pick(n)` returns an integer in [0, n). Injected so the partition is testable. */
export function regionFixture(
  recipients: readonly string[],
  pick: (exclusiveMax: number) => number = randomInt,
): RegionFixture {
  if (!recipients.length || new Set(recipients).size !== recipients.length)
    throw new Error('Oracle recipients must be a non-empty list of distinct agents');
  const panelCount = recipients.length * panelsPerRecipient;
  for (let attempt = 0; attempt < 1000; attempt++) {
    const chosen: number[] = [];
    for (let i = 0; i < panelCount; i++) {
      // Adjacent panels differ so two panels can never read as one wide panel.
      const options = panelColors
        .map((_, index) => index)
        .filter((index) => index !== chosen[i - 1]);
      chosen.push(options[pick(options.length)]!);
    }
    const regions: Record<string, OracleRegion> = {};
    recipients.forEach((recipient, index) => {
      const from = index * panelsPerRecipient;
      regions[recipient] = {
        from: from + 1,
        to: from + panelsPerRecipient,
        answer: chosen
          .slice(from, from + panelsPerRecipient)
          .map((color) => panelColors[color]![0])
          .join(','),
      };
    });
    if (!regionAnswersIsolated(regions)) continue;
    const { png, width } = panelPng(chosen.map((color) => panelColors[color]![1]));
    return {
      png,
      sha256: createHash('sha256').update(png).digest('hex'),
      byteSize: png.length,
      width,
      height,
      panelCount,
      regions,
    };
  }
  throw new Error('Could not draw pairwise distinct region answers');
}

/** True only when no recipient's expected answer equals another recipient's. */
export function regionAnswersIsolated(regions: Record<string, OracleRegion>) {
  const answers = Object.values(regions).map((region) => region.answer);
  return new Set(answers).size === answers.length;
}

/** The shared public question. It names positions and the legal vocabulary only. */
export function regionQuestion(regions: Record<string, OracleRegion>, panelCount: number) {
  const assignments = Object.entries(regions)
    .map(([recipient, region]) => `@${recipient} panels ${region.from} to ${region.to}`)
    .join('; ');
  return (
    `The image has ${panelCount} equal vertical panels, numbered from 1 at the left. ` +
    `Each agent names only its own assigned panels, left to right: ${assignments}. ` +
    'Use each exact color name from red, green, blue, yellow, cyan, purple, black, white as seen. ' +
    'Return only your comma-separated list in the outcome text.'
  );
}

/** Evidence-side guard: no expected answer may appear in a retained or public text. */
export function textHasAnyAnswer(text: string, regions: Record<string, OracleRegion>) {
  return Object.values(regions).some((region) => text.includes(region.answer));
}
