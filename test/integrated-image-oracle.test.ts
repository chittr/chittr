import { expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import {
  panelColors,
  panelsPerRecipient,
  regionAnswersIsolated,
  regionFixture,
  regionQuestion,
  textHasAnyAnswer,
} from '../scripts/integrated-image-oracle.js';

const recipients = ['codex', 'claude', 'grok'];

/** Reads the centre pixel of every panel back out of the encoded PNG. */
function decodedPanels(png: Buffer, panelCount: number) {
  expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  let offset = 8;
  const data: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    if (png.subarray(offset + 4, offset + 8).toString() === 'IDAT')
      data.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const raster = inflateSync(Buffer.concat(data));
  const row = Math.floor(height / 2) * (width * 3 + 1) + 1;
  const panelWidth = width / panelCount;
  return Array.from({ length: panelCount }, (_, panel) => {
    const at = row + Math.floor(panel * panelWidth + panelWidth / 2) * 3;
    const rgb = [...raster.subarray(at, at + 3)];
    return panelColors.find(([, value]) => value.every((part, i) => part === rgb[i]))![0];
  });
}

it('gives every recipient its own disjoint region whose answer matches the encoded pixels', () => {
  for (let run = 0; run < 50; run++) {
    const fixture = regionFixture(recipients);
    expect(fixture.panelCount).toBe(recipients.length * panelsPerRecipient);
    expect(Object.keys(fixture.regions)).toEqual(recipients);
    const panels = decodedPanels(fixture.png, fixture.panelCount);
    // The regions tile the strip exactly once, in roster order.
    const covered = recipients.flatMap((id) => {
      const region = fixture.regions[id]!;
      return Array.from({ length: region.to - region.from + 1 }, (_, i) => region.from + i);
    });
    expect(covered).toEqual(Array.from({ length: fixture.panelCount }, (_, i) => i + 1));
    // The expected answer is the decoded pixels of that region, not a recomputation.
    for (const id of recipients) {
      const region = fixture.regions[id]!;
      expect(region.answer).toBe(panels.slice(region.from - 1, region.to).join(','));
    }
    for (let i = 1; i < panels.length; i++) expect(panels[i]).not.toBe(panels[i - 1]);
    expect(regionAnswersIsolated(fixture.regions)).toBe(true);
  }
});

it('redraws rather than accept two recipients sharing an answer', () => {
  // Scripted picks: the first strip repeats red,green,blue in every region, which
  // would let one public reply satisfy all three assertions. The second is distinct.
  const colliding = [0, 1, 2, 0, 1, 2, 0, 1, 2];
  const distinct = [0, 1, 2, 3, 4, 5, 6, 7, 0];
  const indexOfChoice = (previous: number | undefined, wanted: number) =>
    panelColors
      .map((_, index) => index)
      .filter((index) => index !== previous)
      .indexOf(wanted);
  const script = [colliding, distinct].flatMap((strip) =>
    strip.map((wanted, i) => indexOfChoice(strip[i - 1], wanted)),
  );
  let calls = 0;
  const fixture = regionFixture(recipients, () => script[calls++]!);
  expect(calls).toBe(18);
  expect(Object.values(fixture.regions).map((region) => region.answer)).toEqual([
    'red,green,blue',
    'yellow,cyan,purple',
    'black,white,red',
  ]);
  expect(
    regionAnswersIsolated({
      a: { from: 1, to: 3, answer: 'red,green,blue' },
      b: { from: 4, to: 6, answer: 'red,green,blue' },
    }),
  ).toBe(false);
});

it('asks a shared question that names positions and vocabulary but never an answer', () => {
  const fixture = regionFixture(recipients);
  const question = regionQuestion(fixture.regions, fixture.panelCount);
  expect(question).toContain('@codex panels 1 to 3; @claude panels 4 to 6; @grok panels 7 to 9');
  expect(textHasAnyAnswer(question, fixture.regions)).toBe(false);
  expect(textHasAnyAnswer(`reply: ${fixture.regions.grok!.answer}`, fixture.regions)).toBe(true);
});

it('rejects an empty or repeated roster', () => {
  expect(() => regionFixture([])).toThrow('distinct agents');
  expect(() => regionFixture(['codex', 'codex'])).toThrow('distinct agents');
});
