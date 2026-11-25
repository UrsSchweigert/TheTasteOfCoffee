// Signed pagination cursors (contracts/openapi.yaml, `Cursor`: "The server
// issues cursors HMAC-signed and rejects any cursor it did not issue").
//
// The repository's own cursor is the base64url sort key of the last item
// (src/repository/cursor.ts). The API wraps it:
//
//   cursor = base64url(HMAC-SHA256(key, "cupmark-cursor-v1" \n list \n sub \n inner)) + inner
//
// The MAC is always 43 characters, and both parts use the contract's alphabet
// [A-Za-z0-9_-], so the result is a valid `Cursor`. It binds the cursor to:
// - the list it came from (`shelf`, `brews`, `recipes`), so a brew cursor is
//   refused on the shelf list;
// - the caller (token subject), so a cursor from another user is refused, even
//   though the repository would page only the caller's own partition anyway;
// - the server's key, so a cursor the server did not issue is refused.
// The repository then checks the inner cursor again (canonical encoding, a sort
// key of that list).
//
// The key never comes from the repo (CLAUDE.md, invariant 8); see config.ts.
// Rotating the key invalidates outstanding cursors: clients get 400 and start
// the list again from the top, which is harmless.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { UserId } from '../auth/user-id.ts';
import { CursorSchema } from '../generated/contract.ts';

export type CursorList = 'shelf' | 'brews' | 'recipes';

/** Shortest key accepted: 256 bits, the output size of SHA-256. */
export const MIN_CURSOR_KEY_BYTES = 32;
const MAC_LENGTH = 43; // base64url of 32 bytes, unpadded
const DOMAIN = 'cupmark-cursor-v1';

export class CursorSigner {
  readonly #key: Buffer;

  public constructor(key: Uint8Array) {
    if (key.length < MIN_CURSOR_KEY_BYTES) throw new RangeError('cursor key too short');
    this.#key = Buffer.from(key);
  }

  #mac(list: CursorList, user: UserId, inner: string): string {
    return createHmac('sha256', this.#key).update(`${DOMAIN}\n${list}\n${user.value}\n${inner}`, 'utf8').digest('base64url');
  }

  /** The signed form of the repository cursor `inner`. */
  public sign(list: CursorList, user: UserId, inner: string): string {
    const signed = `${this.#mac(list, user, inner)}${inner}`;
    // A sort key is at most about 60 characters, so this cannot happen; never issue an invalid cursor.
    if (!CursorSchema.safeParse(signed).success) throw new RangeError('cursor out of range');
    return signed;
  }

  /** The repository cursor inside `cursor`, if this server signed it for this list and caller; else undefined. */
  public verify(list: CursorList, user: UserId, cursor: string): string | undefined {
    if (!CursorSchema.safeParse(cursor).success || cursor.length <= MAC_LENGTH) return undefined;
    const inner = cursor.slice(MAC_LENGTH);
    const given = Buffer.from(cursor.slice(0, MAC_LENGTH), 'utf8');
    const expected = Buffer.from(this.#mac(list, user, inner), 'utf8');
    return given.length === expected.length && timingSafeEqual(given, expected) ? inner : undefined;
  }
}
