/**
 * Attachment limits shared by the host, the terminal and the browser. This module
 * has no Node imports so the browser bundle can read the same numbers.
 *
 * 3 MiB raw is 4 MiB as base64, under Claude's strictest per-image limit (5 MB on
 * Bedrock/Vertex). 6 MiB per message is about a quarter of Claude's 32 MB request
 * cap, and 20 images keeps one message from triggering its many-image rule alone.
 */
export const attachmentLimits = {
  acceptedMediaTypes: ['image/png'] as const,
  perImageBytes: 3 * 1024 * 1024,
  aggregateBytes: 6 * 1024 * 1024,
  imagesPerMessage: 20,
  maximumDimension: 4096,
  maximumPixels: 16 * 1024 * 1024,
  abandonedMilliseconds: 24 * 60 * 60 * 1000,
  interruptedWriteMilliseconds: 60 * 60 * 1000,
  maximumSessionAttachments: 4096,
} as const;

/** The long edge the browser scales images down to before upload. */
export const browserImageLongEdge = 2000;

/** Whole mebibytes as `3 MiB`, otherwise exact bytes. */
export function formatAttachmentBytes(bytes: number): string {
  const mebibytes = bytes / (1024 * 1024);
  return Number.isInteger(mebibytes) ? `${mebibytes} MiB` : `${bytes} bytes`;
}

export const attachmentLimitText = {
  perImage: `Image exceeds the ${formatAttachmentBytes(attachmentLimits.perImageBytes)} per-image limit`,
  count: `A message can contain at most ${attachmentLimits.imagesPerMessage} images`,
  aggregate: `Images exceed the ${formatAttachmentBytes(attachmentLimits.aggregateBytes)} per-message limit`,
  summary: `${formatAttachmentBytes(attachmentLimits.perImageBytes)} each, ${attachmentLimits.imagesPerMessage} images and ${formatAttachmentBytes(attachmentLimits.aggregateBytes)} per message`,
} as const;
