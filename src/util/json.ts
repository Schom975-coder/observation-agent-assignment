import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// Same value, same bytes, on every OS: 2-space indent, LF, trailing newline.
// Key order is the order the caller builds objects in, so build them deliberately.
export function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
