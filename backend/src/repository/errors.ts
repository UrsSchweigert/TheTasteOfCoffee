// Errors the repository throws. Messages name the kind of value or item, never
// the value itself, so they are safe to log (log ids and outcomes only).

export class RepositoryError extends Error {
  public override readonly name: string = 'RepositoryError';
}

/** A key part failed validation (bad id, barcode, method, date or user id). Never interpolated. */
export class InvalidKeyError extends RepositoryError {
  public override readonly name = 'InvalidKeyError';
}

/** A create found an item with the same key. */
export class ItemExistsError extends RepositoryError {
  public override readonly name = 'ItemExistsError';
}

/** An update or delete found no such item in the caller's partition. */
export class ItemNotFoundError extends RepositoryError {
  public override readonly name = 'ItemNotFoundError';
}

/** A bean create named a barcode that already points to a bean (API: 409). */
export class BarcodeTakenError extends RepositoryError {
  public override readonly name = 'BarcodeTakenError';
}

/** A bean was verified or rejected that is not (or no longer) unverified. */
export class BeanNotUnverifiedError extends RepositoryError {
  public override readonly name = 'BeanNotUnverifiedError';
}

/** Two writes to the same item raced; the caller may retry. */
export class WriteConflictError extends RepositoryError {
  public override readonly name = 'WriteConflictError';
}

/** A pagination cursor that this repository did not issue for this list (API: 400). */
export class InvalidCursorError extends RepositoryError {
  public override readonly name = 'InvalidCursorError';
}

/** A stored item does not have the shape its key promises, or lies outside the caller's partition. */
export class CorruptItemError extends RepositoryError {
  public override readonly name = 'CorruptItemError';
}

/** Values given to a write do not match the contract schema. Handlers validate first; this is the backstop. */
export class InvalidValuesError extends RepositoryError {
  public override readonly name = 'InvalidValuesError';
}

/** A shelf entry names a bean that is not in the catalogue (API: 404). */
export class BeanNotFoundError extends RepositoryError {
  public override readonly name = 'BeanNotFoundError';
}

/** A brew names a shelf entry that is not in the caller's partition (API: 404). */
export class ShelfEntryNotFoundError extends RepositoryError {
  public override readonly name = 'ShelfEntryNotFoundError';
}

/** A shelf entry cannot be deleted while brews reference it (API: 409). */
export class ShelfEntryInUseError extends RepositoryError {
  public override readonly name = 'ShelfEntryInUseError';
}

/** A shelf entry replace would change `bean_id` while brews reference the entry (API: 409; D14). */
export class ShelfEntryBeanLockedError extends RepositoryError {
  public override readonly name = 'ShelfEntryBeanLockedError';
}

/**
 * `POST /beans` with `open_food_facts_confirmed`, but the server holds no cached
 * Open Food Facts hit for the barcode, only a miss or nothing (API: 409).
 */
export class OpenFoodFactsHitMissingError extends RepositoryError {
  public override readonly name = 'OpenFoodFactsHitMissingError';
}

/** A label photo completion for a photo that is already completed (API: 409). */
export class LabelPhotoCompletedError extends RepositoryError {
  public override readonly name = 'LabelPhotoCompletedError';
}

/** The caller already has the most label photos allowed for the bean (API: 409; ADR 0016). */
export class LabelPhotoCapReachedError extends RepositoryError {
  public override readonly name = 'LabelPhotoCapReachedError';
}

/**
 * The caller's account is being deleted or was deleted: its tombstone
 * (`DELETED#<sub>` / `META`) is in force, so no write of the caller is
 * accepted (API: 401; ADR 0017, Addendum). Nothing was written.
 */
export class AccountDeletedError extends RepositoryError {
  public override readonly name = 'AccountDeletedError';
}

/** Account deletion could not delete every item of the partition, even after retries (API: 500; the app retries). */
export class DeletionIncompleteError extends RepositoryError {
  public override readonly name = 'DeletionIncompleteError';
}

/** The write of the nightly rebuild left requests unprocessed after its retries. The run fails; the next night repairs it. */
export class AggregateWriteIncompleteError extends RepositoryError {
  public override readonly name = 'AggregateWriteIncompleteError';
}
