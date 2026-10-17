// Milliseconds since the epoch for the "YYYY-MM-DDTHH:MM:SSZ" strings parseDate produces.
// Built from the parts so no JavaScript date-string parsing is involved.
export function utcMs(iso: string): number {
  return Date.UTC(
    Number(iso.slice(0, 4)),
    Number(iso.slice(5, 7)) - 1,
    Number(iso.slice(8, 10)),
    Number(iso.slice(11, 13)),
    Number(iso.slice(14, 16)),
    Number(iso.slice(17, 19)),
  );
}

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
