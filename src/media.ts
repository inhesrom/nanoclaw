/**
 * WhatsApp media ingest: save originals under group attachments/, build path
 * markers for the agent, and produce vision-friendly JPEG sidecars for images.
 */
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

const MAX_DIMENSION = 1024;
/** Videos larger than this get an error marker instead of being saved. */
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

/** Matches `[Image: attachments/…]` path markers in stored/formatted messages. */
export const IMAGE_REF_PATTERN = /\[Image: (attachments\/[^\]]+)\]/g;

export interface ProcessedMedia {
  /** Message content stored in DB (marker + optional caption). */
  content: string;
  /** Relative path to the archival original under the group folder. */
  relativePath: string;
  /** Relative path preferred for vision (may equal relativePath). */
  visionRelativePath: string;
}

export interface ImageAttachment {
  relativePath: string;
  mediaType: string;
}

function attachDir(groupDir: string): string {
  const dir = path.join(groupDir, 'attachments');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function uniqueId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

export function extFromMime(
  mime: string | undefined | null,
  fallback: string,
): string {
  if (!mime) return fallback;
  const base = mime.split(';')[0].trim().toLowerCase();
  const map: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'video/mp4': '.mp4',
    'video/3gpp': '.3gp',
    'video/quicktime': '.mov',
    'application/pdf': '.pdf',
    'audio/ogg': '.ogg',
    'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a',
  };
  return map[base] || fallback;
}

export function mediaTypeFromPath(relativePath: string): string {
  const ext = path.extname(relativePath).toLowerCase();
  switch (ext) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    default:
      return 'image/jpeg';
  }
}

/**
 * Resolve the best on-disk file for vision given a marker path.
 * Prefers a `.vision.jpg` sidecar next to the original when present.
 */
export function resolveVisionRelativePath(relativePath: string): string {
  // attachments/img-1.png -> attachments/img-1.vision.jpg
  const dir = path.dirname(relativePath);
  const base = path.basename(relativePath, path.extname(relativePath));
  return path.join(dir, `${base}.vision.jpg`).replace(/\\/g, '/');
}

export async function processImage(
  buffer: Buffer,
  groupDir: string,
  caption: string,
  mime?: string | null,
): Promise<ProcessedMedia | null> {
  if (!buffer || buffer.length === 0) return null;

  const id = uniqueId();
  const dir = attachDir(groupDir);
  const origExt = extFromMime(mime, '.jpg');
  const origName = `img-${id}${origExt}`;
  const origRel = `attachments/${origName}`;
  const visionName = `img-${id}.vision.jpg`;
  const visionRel = `attachments/${visionName}`;

  fs.writeFileSync(path.join(dir, origName), buffer);

  const resized = await sharp(buffer)
    .resize(MAX_DIMENSION, MAX_DIMENSION, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: 85 })
    .toBuffer();
  fs.writeFileSync(path.join(dir, visionName), resized);

  const marker = `[Image: ${origRel}]`;
  const content = caption ? `${marker} ${caption}` : marker;
  return {
    content,
    relativePath: origRel,
    visionRelativePath: visionRel,
  };
}

export function processVideo(
  buffer: Buffer,
  groupDir: string,
  caption: string,
  mime?: string | null,
): ProcessedMedia | null {
  if (!buffer || buffer.length === 0) return null;

  if (buffer.length > MAX_VIDEO_BYTES) {
    const sizeMB = Math.round(buffer.length / (1024 * 1024));
    const limitMB = Math.round(MAX_VIDEO_BYTES / (1024 * 1024));
    const content = caption
      ? `[Video: too large (${sizeMB}MB > ${limitMB}MB limit)] ${caption}`
      : `[Video: too large (${sizeMB}MB > ${limitMB}MB limit)]`;
    return {
      content,
      relativePath: '',
      visionRelativePath: '',
    };
  }

  const id = uniqueId();
  const dir = attachDir(groupDir);
  const ext = extFromMime(mime, '.mp4');
  const name = `vid-${id}${ext}`;
  const rel = `attachments/${name}`;
  fs.writeFileSync(path.join(dir, name), buffer);

  const sizeKB = Math.round(buffer.length / 1024);
  const marker = `[Video: ${rel} (${sizeKB}KB)]`;
  const content = caption ? `${marker} ${caption}` : marker;
  return {
    content,
    relativePath: rel,
    visionRelativePath: '',
  };
}

export function processDocument(
  buffer: Buffer,
  groupDir: string,
  opts: {
    caption?: string;
    mime?: string | null;
    fileName?: string | null;
  },
): ProcessedMedia | null {
  if (!buffer || buffer.length === 0) return null;

  const mime = (opts.mime || 'application/octet-stream').split(';')[0].trim();
  const caption = opts.caption || '';

  // High-res photos sometimes arrive as documents — route to image pipeline.
  if (mime.startsWith('image/')) {
    // Caller should use processImage; keep a sync fallback that only saves original.
    const id = uniqueId();
    const dir = attachDir(groupDir);
    const ext = extFromMime(mime, '.bin');
    const name = `img-${id}${ext}`;
    const rel = `attachments/${name}`;
    fs.writeFileSync(path.join(dir, name), buffer);
    const marker = `[Image: ${rel}]`;
    return {
      content: caption ? `${marker} ${caption}` : marker,
      relativePath: rel,
      visionRelativePath: rel,
    };
  }

  const dir = attachDir(groupDir);
  const rawName = opts.fileName || `doc-${uniqueId()}${extFromMime(mime, '')}`;
  // Prevent path traversal from WA-supplied names
  const safeName = path.basename(rawName).replace(/[^\w.\- ()[\]]+/g, '_') || `doc-${uniqueId()}`;
  const filePath = path.join(dir, safeName);
  // Avoid clobbering: if exists, prefix with id
  const finalName = fs.existsSync(filePath)
    ? `${uniqueId()}-${safeName}`
    : safeName;
  fs.writeFileSync(path.join(dir, finalName), buffer);

  const rel = `attachments/${finalName}`;
  const sizeKB = Math.round(buffer.length / 1024);

  if (mime === 'application/pdf') {
    const marker = `[PDF: ${rel} (${sizeKB}KB)]`;
    return {
      content: caption ? `${caption}\n\n${marker}` : marker,
      relativePath: rel,
      visionRelativePath: '',
    };
  }

  const marker = `[Attachment: ${rel} (${mime}, ${sizeKB}KB)]`;
  return {
    content: caption ? `${caption}\n\n${marker}` : marker,
    relativePath: rel,
    visionRelativePath: '',
  };
}

/**
 * Extract image attachment refs from message contents or a single prompt string.
 * Vision loaders should prefer a `.vision.jpg` sidecar when present on disk.
 */
export function parseImageReferences(
  messages: Array<{ content: string }> | string,
): ImageAttachment[] {
  const texts =
    typeof messages === 'string' ? [messages] : messages.map((m) => m.content);
  const refs: ImageAttachment[] = [];
  const seen = new Set<string>();

  for (const text of texts) {
    if (!text) continue;
    IMAGE_REF_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = IMAGE_REF_PATTERN.exec(text)) !== null) {
      const relativePath = match[1];
      if (seen.has(relativePath)) continue;
      seen.add(relativePath);
      refs.push({
        relativePath,
        mediaType: mediaTypeFromPath(relativePath),
      });
    }
  }
  return refs;
}
