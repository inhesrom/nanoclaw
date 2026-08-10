import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';

vi.mock('sharp', () => {
  const mockSharp = vi.fn(() => ({
    resize: vi.fn().mockReturnThis(),
    jpeg: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from('resized-image-data')),
  }));
  return { default: mockSharp };
});

vi.mock('fs');

import {
  processImage,
  processVideo,
  processDocument,
  parseImageReferences,
  resolveVisionRelativePath,
  MAX_VIDEO_BYTES,
} from './media.js';

describe('media processing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined as never);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  describe('processImage', () => {
    it('saves original + vision sidecar and returns marker with caption', async () => {
      const buffer = Buffer.from('raw-image-data');
      const result = await processImage(
        buffer,
        '/tmp/groups/test',
        'Check this out',
        'image/png',
      );

      expect(result).not.toBeNull();
      expect(result!.content).toMatch(
        /^\[Image: attachments\/img-\d+-[a-z0-9]+\.png\] Check this out$/,
      );
      expect(result!.relativePath).toMatch(
        /^attachments\/img-\d+-[a-z0-9]+\.png$/,
      );
      expect(result!.visionRelativePath).toMatch(
        /^attachments\/img-\d+-[a-z0-9]+\.vision\.jpg$/,
      );
      expect(fs.mkdirSync).toHaveBeenCalled();
      // original + vision
      expect(fs.writeFileSync).toHaveBeenCalledTimes(2);
    });

    it('returns content without caption when none provided', async () => {
      const result = await processImage(
        Buffer.from('raw'),
        '/tmp/groups/test',
        '',
      );

      expect(result).not.toBeNull();
      expect(result!.content).toMatch(
        /^\[Image: attachments\/img-\d+-[a-z0-9]+\.jpg\]$/,
      );
    });

    it('returns null on empty buffer', async () => {
      const result = await processImage(
        Buffer.alloc(0),
        '/tmp/groups/test',
        '',
      );
      expect(result).toBeNull();
    });
  });

  describe('processVideo', () => {
    it('saves video and returns marker', () => {
      const result = processVideo(
        Buffer.from('video-bytes'),
        '/tmp/groups/test',
        'look',
        'video/mp4',
      );
      expect(result).not.toBeNull();
      expect(result!.content).toMatch(
        /^\[Video: attachments\/vid-\d+-[a-z0-9]+\.mp4 \(\d+KB\)\] look$/,
      );
    });

    it('rejects oversized videos with error marker', () => {
      const big = Buffer.alloc(MAX_VIDEO_BYTES + 1);
      const result = processVideo(big, '/tmp/groups/test', 'huge');
      expect(result).not.toBeNull();
      expect(result!.content).toContain('[Video: too large');
      expect(result!.relativePath).toBe('');
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });
  });

  describe('processDocument', () => {
    it('marks PDFs specially', () => {
      const result = processDocument(Buffer.from('%PDF'), '/tmp/groups/test', {
        mime: 'application/pdf',
        fileName: 'report.pdf',
      });
      expect(result!.content).toContain('[PDF: attachments/report.pdf');
    });

    it('marks generic attachments', () => {
      const result = processDocument(Buffer.from('docx'), '/tmp/groups/test', {
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        fileName: 'notes.docx',
        caption: 'here',
      });
      expect(result!.content).toContain('[Attachment: attachments/notes.docx');
      expect(result!.content).toContain('here');
    });

    it('sanitizes path traversal in file names', () => {
      const result = processDocument(Buffer.from('x'), '/tmp/groups/test', {
        mime: 'text/plain',
        fileName: '../../etc/passwd',
      });
      expect(result!.relativePath).toBe('attachments/passwd');
      expect(result!.relativePath).not.toContain('..');
    });
  });

  describe('parseImageReferences', () => {
    it('extracts image paths from message content', () => {
      const messages = [
        { content: '[Image: attachments/img-123.jpg] hello' },
        { content: 'plain text' },
        { content: '[Image: attachments/img-456.png]' },
      ];
      const refs = parseImageReferences(messages);

      expect(refs).toEqual([
        { relativePath: 'attachments/img-123.jpg', mediaType: 'image/jpeg' },
        { relativePath: 'attachments/img-456.png', mediaType: 'image/png' },
      ]);
    });

    it('parses a single prompt string', () => {
      const refs = parseImageReferences(
        '<message>[Image: attachments/a.jpg] hi</message>',
      );
      expect(refs).toEqual([
        { relativePath: 'attachments/a.jpg', mediaType: 'image/jpeg' },
      ]);
    });

    it('dedupes repeated paths', () => {
      const refs = parseImageReferences(
        '[Image: attachments/a.jpg] [Image: attachments/a.jpg]',
      );
      expect(refs).toHaveLength(1);
    });

    it('returns empty array when no images', () => {
      expect(parseImageReferences([{ content: 'just text' }])).toEqual([]);
    });
  });

  describe('resolveVisionRelativePath', () => {
    it('maps original to vision sidecar path', () => {
      expect(resolveVisionRelativePath('attachments/img-1.png')).toBe(
        'attachments/img-1.vision.jpg',
      );
    });
  });
});
