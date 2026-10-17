import type { IncomingMessage, ServerResponse } from 'http';
import type { Telegram } from 'telegraf';
import { kycEnabled, parseKycResult, validResultSignature } from './link';
import { applyKycResult } from './result';

export const KYC_RESULT_PATH = '/kyc/result';
const MAX_BODY_BYTES = 64 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** POST /kyc/result: a signed face-scan result from the KYC app. */
export async function handleKycResultRequest(req: IncomingMessage, res: ServerResponse, telegram: Telegram) {
  const reply = (status: number, text: string) => {
    res.writeHead(status, { 'Content-Type': 'text/plain' });
    res.end(text);
  };
  if (!kycEnabled()) return reply(404, 'Not found');
  try {
    const body = await readBody(req);
    if (!body) return reply(413, 'Too large');
    const signature = req.headers['x-kyc-signature'];
    if (!validResultSignature(body, Array.isArray(signature) ? signature[0] : signature)) {
      return reply(401, 'Bad signature');
    }
    const result = parseKycResult(body);
    if (!result) return reply(400, 'Bad result');
    await applyKycResult(telegram, result);
    reply(200, 'OK');
  } catch (err) {
    // A 5xx makes the KYC app retry, which applyKycResult is safe against.
    console.error('Error applying KYC result:', err);
    reply(500, 'Error');
  }
}
