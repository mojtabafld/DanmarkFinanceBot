import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import sharp from 'sharp';
import axios from 'axios';

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
 * @param fileUrl The direct download link of the photo.
 * @returns A Promise resolving to the processed image Buffer (either masked or original as fallback).
 */
export async function maskImage(fileUrl: string): Promise<Buffer> {
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
    // Danish CPR pattern: DDMMYY-XXXX (e.g. 251290-1234) or 10-digit number
    const cprRegex = /\b\d{6}-\d{4}\b|\b\d{10}\b/;
    
    // Address elements
    const addressSuffixes = ['vej', 'gade', 'allé', 'plads', 'boulevard', 'stræde', 'have', 'park', 'toft', 'skov'];
    const zipCodeRegex = /\b[1-9]\d{3}\b/; // Danish zip codes are 4 digits (1000 - 9999)

    const boxesToMask: BBox[] = [];

    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      let shouldMask = false;

      if (cprRegex.test(box.text)) {
        shouldMask = true;
      } else if (zipCodeRegex.test(box.text)) {
        shouldMask = true;
      } else {
        const textLower = box.text.toLowerCase();
        for (const suffix of addressSuffixes) {
          if (textLower.endsWith(suffix)) {
            shouldMask = true;
            break;
          }
        }
      }

      if (shouldMask) {
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
      return imageBuffer;
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

    return await sharp(imageBuffer)
      .composite([{ input: Buffer.from(svgOverlay), blend: 'over' }])
      .toBuffer();

  } catch (err) {
    console.error('OCR/Masking failed critically:', err);
    // Cleanup temporary file in case of error
    if (tempInputPath) {
      try { fs.unlinkSync(tempInputPath); } catch {}
    }
    throw new Error('OCR document processing failed. Image masking could not be verified safely.');
  }
}
