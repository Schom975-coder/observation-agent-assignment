import { createHash } from 'node:crypto';

export const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

// The ID Git gives a file's contents. Matching it proves bytes are exactly what the repo holds.
export const gitBlobSha = (bytes: Uint8Array): string =>
  createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
