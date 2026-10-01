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

/** A PNG's IHDR dimensions and whether its compression, filter and interlace
 * methods are all 0 as the host requires. Undefined for anything else. */
function pngHeader(
  bytes: Uint8Array,
): { width: number; height: number; hostMethods: boolean } | undefined {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (
    bytes.length < 33 ||
    signature.some((value, index) => bytes[index] !== value) ||
    String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR'
  )
    return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    width: view.getUint32(16),
    height: view.getUint32(20),
    hostMethods: bytes[26] === 0 && bytes[27] === 0 && bytes[28] === 0,
  };
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
 * Returns the bytes to upload for a selected image. A non-interlaced PNG within
 * the long edge and per-image limit uploads unchanged. Anything else the browser
 * can decode is scaled down (never up) to the long edge and encoded as PNG,
 * then scaled further until it fits the per-image limit.
 */
export async function prepareImage(file: File): Promise<PreparedImage> {
  const header = pngHeader(new Uint8Array(await file.arrayBuffer()));
  if (
    header?.hostMethods &&
    header.width > 0 &&
    header.height > 0 &&
    Math.max(header.width, header.height) <= browserImageLongEdge &&
    file.size <= attachmentLimits.perImageBytes
  )
    // The same bytes, labelled as the PNG they are for the host's media-type check.
    return {
      file: file.type === 'image/png' ? file : new File([file], file.name, { type: 'image/png' }),
      converted: false,
    };
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('This file could not be read as an image.');
  }
  try {
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
