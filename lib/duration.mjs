// A single duration grammar shared by every flag that accepts a relative
// window (`--since`, and upcoming `--stale-after`, `--lock-stale-ms`,
// `--interval`, `--timeout`, ...). Without this module each flag would grow
// its own copy-pasted regex and rounding rules, and they would inevitably
// drift apart — a duration that parses for one flag but not another is a
// trap for both humans and agents driving this CLI. One implementation,
// one grammar, one error-message shape.
const DURATION_GRAMMAR = /^([0-9]+)([smhd])$/;
const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * Parse a duration like `90s`, `15m`, `24h`, or `7d` into milliseconds.
 *
 * Grammar: a positive integer immediately followed by one unit character
 * (`s`, `m`, `h`, or `d`). No decimals, no whitespace, no zero or negative
 * values, no bare numbers, no other units.
 *
 * @param {string|unknown} raw - The raw flag value.
 * @param {{ flag?: string }} [options] - `flag` names the CLI flag (e.g.
 *   `--since`) so the error message points at the flag that actually failed,
 *   even though the grammar itself is shared. Defaults to a generic label:
 *   this function is a published export (`gh-delta/duration`), so an external
 *   caller that omits the option must get the normal `{ error }` result rather
 *   than a TypeError from destructuring `undefined`.
 * @returns {{ ms: number } | { error: string }}
 */
export function parseDuration(raw, { flag = 'duration' } = {}) {
  const match = DURATION_GRAMMAR.exec(String(raw ?? ''));
  const value = match ? Number(match[1]) : 0;
  if (!match || value <= 0) {
    return {
      error: `${flag} must be a positive integer followed by s, m, h, or d (e.g. 24h); got "${raw}"`,
    };
  }
  return { ms: value * UNIT_MS[match[2]] };
}
