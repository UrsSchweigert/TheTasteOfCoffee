// Pagination cursors (contracts/openapi.yaml, `Cursor`). A cursor carries only
// the sort key of the last item of a page, base64url-encoded. The partition key
// is never in it: the next page is always read from the caller's own partition,
// so a cursor taken from another user, or forged, cannot reach another
// partition. A cursor is accepted only if it decodes to a sort key of the list
// it is used with.
import { CursorSchema } from '../generated/contract.ts';
import { InvalidCursorError } from './errors.ts';

export function encodeCursor(sortKey: string): string {
  return Buffer.from(sortKey, 'utf8').toString('base64url');
}

/**
 * The sort key in `cursor`, if `cursor` is a canonical encoding of a sort key
 * that `isSortKey` accepts. Throws InvalidCursorError otherwise.
 */
export function decodeCursor(cursor: string, isSortKey: (sk: string) => boolean): string {
  if (!CursorSchema.safeParse(cursor).success) throw new InvalidCursorError('invalid cursor');
  const sortKey = Buffer.from(cursor, 'base64url').toString('utf8');
  // Node ignores stray characters and padding; only the canonical form is ours.
  if (encodeCursor(sortKey) !== cursor || !isSortKey(sortKey)) throw new InvalidCursorError('invalid cursor');
  return sortKey;
}
