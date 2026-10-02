import {
  attachmentLimits,
  browserImageLongEdge,
  formatAttachmentBytes,
} from '../src/attachment-limits.js';

export interface PreparedImage {
  /** The PNG to upload. */
  file: File;
  /** True when its bytes differ from the selected file. */
  converted: boolean;
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * The IHDR dimensions of a PNG whose structure the host accepts: compression,
 * filter and interlace methods all 0, every chunk checksum valid, image data
 * present and IEND as the last bytes. Undefined for anything else, which the
 * browser re-encodes instead. Browsers decode PNGs the host would refuse, such as
 * interlaced ones or ones with bytes after IEND.
 */
function hostReadyPng(bytes: Uint8Array): { width: number; height: number } | undefined {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 33 || signature.some((value, index) => bytes[index] !== value)) return;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (view.getUint32(8) !== 13 || type(12) !== 'IHDR') return;
  if (bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] !== 0) return;
  let data = false;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = view.getUint32(offset);
    if (length > bytes.length - offset - 12) return;
    const end = offset + 8 + length;
    if (crc32(bytes.subarray(offset + 4, end)) !== view.getUint32(end)) return;
    if (type(offset + 4) === 'IDAT') data = true;
    if (type(offset + 4) === 'IEND')
      return data && length === 0 && end + 4 === bytes.length
        ? { width: view.getUint32(16), height: view.getUint32(20) }
        : undefined;
    offset = end + 4;
  }
}

/** The selected name with a `.png` extension. */
export function pngFilename(name: string): string {
  const stem = name.replace(/\.[^./\\]*$/, '') || 'image';
  return `${stem.slice(0, 251)}.png`;
}

async function encodePng(bitmap: ImageBitmap, width: number, height: number): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser cannot convert images.');
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, 0, 0, width, height);
  return canvas.convertToBlob({ type: 'image/png' });
}

/**
 * Returns the bytes to upload for a selected image. Only a file the browser can
 * decode is uploaded. A host-ready, non-interlaced PNG within the long edge and
 * per-image limit uploads unchanged. Anything else is scaled down (never up) to
 * the long edge and encoded as PNG, then scaled further until it fits the
 * per-image limit.
 */
export async function prepareImage(file: File): Promise<PreparedImage> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('This file could not be read as an image.');
  }
  try {
    const png = hostReadyPng(new Uint8Array(await file.arrayBuffer()));
    if (
      png &&
      png.width > 0 &&
      png.height > 0 &&
      Math.max(png.width, png.height) <= browserImageLongEdge &&
      file.size <= attachmentLimits.perImageBytes
    )
      // The same bytes, labelled as the PNG they are for the host's media-type check.
      return {
        file: file.type === 'image/png' ? file : new File([file], file.name, { type: 'image/png' }),
        converted: false,
      };
    let scale = Math.min(1, browserImageLongEdge / Math.max(bitmap.width, bitmap.height));
    for (let attempt = 0; attempt < 8; attempt++) {
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const blob = await encodePng(bitmap, width, height);
      if (blob.size <= attachmentLimits.perImageBytes)
        return {
          file: new File([blob], pngFilename(file.name), { type: 'image/png' }),
          converted: true,
        };
      // Encoded size tracks pixel count, so shrink both edges by the square root.
      scale *= Math.sqrt(attachmentLimits.perImageBytes / blob.size) * 0.95;
    }
  } finally {
    bitmap.close();
  }
  throw new Error(
    `This image could not be made smaller than ${formatAttachmentBytes(attachmentLimits.perImageBytes)}.`,
  );
}
