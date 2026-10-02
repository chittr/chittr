import { deflateSync } from 'node:zlib';

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data = Buffer.alloc(0)): Buffer {
  const name = Buffer.from(type, 'ascii');
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  name.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return result;
}

function png(red: number, padding = 0, width = 1, height = 1): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    ...(padding ? [chunk('tEXt', Buffer.alloc(padding, 97))] : []),
    chunk('IDAT', deflateSync(Buffer.from([0, red, 0, 0, 255]))),
    chunk('IEND'),
  ]);
}

export const tinyPng = () => png(0);

export const alternatePng = () => png(255);
export const paddedPng = (size: number) => png(127, Math.max(0, size - png(127).length - 12));
export const dimensionPng = (width: number, height: number) => png(127, 0, width, height);

export function widePng(): Buffer {
  const width = 2048;
  const height = 64;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const pixels = Buffer.alloc(height * (width * 4 + 1));
  for (let row = 0; row < height; row++)
    for (let column = 0; column < width; column++)
      pixels[row * (width * 4 + 1) + 1 + column * 4 + 3] = 255;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND'),
  ]);
}

/** A non-interlaced RGBA PNG whose pixels `pixel` fills row by row. */
function rgbaPng(
  width: number,
  height: number,
  pixel: (index: number) => [number, number, number, number],
): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const stride = width * 4 + 1;
  const pixels = Buffer.alloc(height * stride);
  for (let row = 0, index = 0; row < height; row++)
    for (let column = 0; column < width; column++, index++)
      pixels.set(pixel(index), row * stride + 1 + column * 4);
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND'),
  ]);
}

/** One opaque colour: compresses to a few kilobytes at any size. */
export const solidPng = (width: number, height: number) =>
  rgbaPng(width, height, () => [40, 120, 200, 255]);

/** Deterministic opaque noise: incompressible, so about 4 bytes per pixel. */
export function noisePng(width: number, height: number, seed = 1): Buffer {
  let state = seed >>> 0 || 1;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  return rgbaPng(width, height, () => {
    const value = next();
    return [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, 255];
  });
}

/** A 1×1 PNG using Adam7 interlacing, which browsers decode and the host refuses. */
export function interlacedPng(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr.set([8, 6, 0, 0, 1], 8);
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    // A 1×1 image has pixels only in the first Adam7 pass.
    chunk('IDAT', deflateSync(Buffer.from([0, 200, 30, 30, 255]))),
    chunk('IEND'),
  ]);
}
