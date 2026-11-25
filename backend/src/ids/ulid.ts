// Server-generated ids (contracts/openapi.yaml, `Id`): ULIDs, 26 characters of
// Crockford base32. The first 10 encode the creation time in milliseconds, the
// last 16 are 80 random bits, so ids sort by creation time.
import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const MAX_TIME = 2 ** 48 - 1;

/** A new ULID for the given time (default: now). */
export function newUlid(time: number = Date.now()): string {
  if (!Number.isInteger(time) || time < 0 || time > MAX_TIME) {
    throw new RangeError('ULID time out of range');
  }
  let timePart = '';
  let rest = time;
  for (let i = 0; i < 10; i += 1) {
    timePart = `${ALPHABET.charAt(rest % 32)}${timePart}`;
    rest = Math.floor(rest / 32);
  }
  // 80 random bits as 16 symbols of 5 bits each.
  const bytes = randomBytes(10);
  let randomPart = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      randomPart += ALPHABET.charAt((buffer >> bits) & 31);
    }
    buffer &= (1 << bits) - 1;
  }
  return timePart + randomPart;
}
