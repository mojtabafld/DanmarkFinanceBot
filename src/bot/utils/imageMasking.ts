import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import sharp from 'sharp';
import axios from 'axios';

/** Danish CPR: DDMMYY-XXXX (e.g. 251290-1234) or the same 10 digits unseparated. */
export const CPR_REGEX = /\b\d{6}-\d{4}\b|\b\d{10}\b/;

/** Danish postal codes are four digits, 1000-9999. */
export const ZIP_CODE_REGEX = /\b[1-9]\d{3}\b/;

/** Word endings that mark a Danish street name. */
export const ADDRESS_SUFFIXES = [
  'vej', 'gade', 'allé', 'plads', 'boulevard', 'stræde', 'have', 'park', 'toft', 'skov'
];

/** True when an OCR'd word looks like a CPR number, a postal code or a street name. */
export function isSensitiveToken(text: string): boolean {
  if (CPR_REGEX.test(text)) return true;
  if (ZIP_CODE_REGEX.test(text)) return true;
  const lower = text.toLowerCase();
  return ADDRESS_SUFFIXES.some(suffix => lower.endsWith(suffix));
}

export interface MaskResult {
  /** The image to forward on: masked when `maskedCount > 0`, otherwise the original. */
  buffer: Buffer;
  /** How many word boxes were blacked out. Zero means nothing was detected. */
  maskedCount: number;
}

// Bounding box interface
interface BBox {
  left: number;
  top: number;
  width: number;
  height: number;
  text: string;
}

/**
 * Downloads a photo from a given URL, runs Tesseract OCR locally to find Danish CPR numbers
 * or address elements, and draws black rectangles over those areas.
 * 
 * Returns the number of boxes it actually covered alongside the image, so callers can
 * tell the user the truth: finding no CPR or address pattern is not the same as
 * having redacted one, and claiming otherwise would be a false privacy assurance.
 *
 * @param fileUrl The direct download link of the photo.
 */
export async function maskImage(fileUrl: string): Promise<MaskResult> {
  let tempInputPath = '';
  let imageBuffer: Buffer;

  try {
    // 1. Download image
    const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
    imageBuffer = Buffer.from(response.data, 'binary');
  } catch (err) {
    console.error('Failed to download image for masking:', err);
    throw err;
  }

  // Generate unique temp file path
  tempInputPath = path.join(os.tmpdir(), `ocr_in_${Date.now()}_${Math.random().toString(36).substring(7)}.jpg`);

  try {
    fs.writeFileSync(tempInputPath, imageBuffer);

    // 2. Perform OCR and get TSV layout output on stdout
    // Uses both Danish (dan) and English (eng) languages
    const cmd = `tesseract "${tempInputPath}" stdout -l dan+eng tsv`;
    const tsvOutput = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

    // Clean up temp file immediately after run
    try { fs.unlinkSync(tempInputPath); tempInputPath = ''; } catch {}

    // 3. Parse TSV and identify word boxes
    const lines = tsvOutput.split('\n');
    const boxes: BBox[] = [];

    for (const line of lines) {
      const parts = line.split('\t');
      if (parts.length < 12) continue;

      // Skip row if confidence is empty or too low (e.g. less than 30%)
      const conf = parseFloat(parts[10]);
      if (isNaN(conf) || conf < 30) continue;

      const text = parts[11].trim();
      if (!text) continue;

      const left = parseInt(parts[6], 10);
      const top = parseInt(parts[7], 10);
      const width = parseInt(parts[8], 10);
      const height = parseInt(parts[9], 10);

      if (isNaN(left) || isNaN(top) || isNaN(width) || isNaN(height)) continue;

      boxes.push({ left, top, width, height, text });
    }

    // 4. Identify boxes to mask (CPR numbers or address strings)
    const boxesToMask: BBox[] = [];

    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];

      if (isSensitiveToken(box.text)) {
        boxesToMask.push(box);
        
        // Also mask immediately adjacent boxes on the same line to mask the entire address line/value
        const verticalTolerance = box.height * 0.5;

        // Mask 1 word before
        if (i > 0) {
          const prevBox = boxes[i - 1];
          const isSameLine = Math.abs(prevBox.top - box.top) < verticalTolerance;
          const isCloseHorizontal = (box.left - (prevBox.left + prevBox.width)) < box.height * 2;
          if (isSameLine && isCloseHorizontal) {
            boxesToMask.push(prevBox);
          }
        }

        // Mask up to 3 words after
        for (let j = 1; j <= 3; j++) {
          if (i + j < boxes.length) {
            const nextBox = boxes[i + j];
            const prevBoxInSequence = boxes[i + j - 1];
            const isSameLine = Math.abs(nextBox.top - box.top) < verticalTolerance;
            const isCloseHorizontal = (nextBox.left - (prevBoxInSequence.left + prevBoxInSequence.width)) < box.height * 2;
            if (isSameLine && isCloseHorizontal) {
              boxesToMask.push(nextBox);
            }
          }
        }
      }
    }

    if (boxesToMask.length === 0) {
      console.log('No CPR or address patterns detected on document. Sending original image.');
      return { buffer: imageBuffer, maskedCount: 0 };
    }

    // 5. Redraw image by placing black rectangles over the selected bounding boxes
    const metadata = await sharp(imageBuffer).metadata();
    const width = metadata.width || 800;
    const height = metadata.height || 600;

    const rects = boxesToMask.map(box => {
      // Add slight padding to guarantee coverage
      const paddingX = Math.max(2, Math.floor(box.width * 0.15));
      const paddingY = Math.max(2, Math.floor(box.height * 0.15));
      
      const x = Math.max(0, box.left - paddingX);
      const y = Math.max(0, box.top - paddingY);
      const w = Math.min(width - x, box.width + paddingX * 2);
      const h = Math.min(height - y, box.height + paddingY * 2);
      
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="black" />`;
    }).join('\n');

    const svgOverlay = `<svg width="${width}" height="${height}">${rects}</svg>`;

    console.log(`Masking ${boxesToMask.length} word boxes containing CPR or address information.`);

    const masked = await sharp(imageBuffer)
      .composite([{ input: Buffer.from(svgOverlay), blend: 'over' }])
      .toBuffer();

    return { buffer: masked, maskedCount: boxesToMask.length };

  } catch (err) {
    console.error('OCR/Masking failed critically:', err);
    // Cleanup temporary file in case of error
    if (tempInputPath) {
      try { fs.unlinkSync(tempInputPath); } catch {}
    }
    throw new Error('OCR document processing failed. Image masking could not be verified safely.');
  }
}
