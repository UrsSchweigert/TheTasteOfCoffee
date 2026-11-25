// Which Open Food Facts image URL the server may follow (task M1-T4c; ADR
// 0011). The URL comes from the product's `image_front_url` and is untrusted.
//
// Assumption (the Open Food Facts docs could not be fetched from the build
// environment): front images live on `https://images.openfoodfacts.org` under
// `/images/products/<ean split 3/3/3/4>/front_<lang>.<revision>.<size>.jpg`,
// for example `.../400/638/133/3931/front_de.3.400.jpg`, with size 100, 200,
// 400 or `full`; `image_front_url` names the 400-pixel display image.
//
// Only a URL that is exactly that shape, character for character, is
// followed: https, that host, no userinfo, no port, no query, no fragment, no
// percent-encoding or dot segments, and the four path parts joined must be the
// same canonical EAN-13 as the lookup. Anything else means "no image".

export const OPEN_FOOD_FACTS_IMAGE_ORIGIN = 'https://images.openfoodfacts.org';

const FRONT_IMAGE = /^https:\/\/images\.openfoodfacts\.org\/images\/products\/(\d{3})\/(\d{3})\/(\d{3})\/(\d{4})\/front(?:_[a-z]{2,3})?\.[1-9]\d{0,5}\.(?:100|200|400|full)\.jpg$/;

/** The longest URL of that shape is well under this; a longer value is not looked at. */
const MAX_URL_LENGTH = 200;

/**
 * `value` if it is a front-image URL for `ean` on the Open Food Facts image
 * host, else undefined. `ean` must already be the canonical 13 digits.
 */
export function frontImageUrl(value: unknown, ean: string): string | undefined {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH || !/^\d{13}$/.test(ean)) return undefined;
  const match = FRONT_IMAGE.exec(value);
  if (match?.slice(1, 5).join('') !== ean) return undefined;
  // Defence in depth: the WHATWG parser must agree on every part.
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    url.href !== value ||
    url.origin !== OPEN_FOOD_FACTS_IMAGE_ORIGIN ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    return undefined;
  }
  return value;
}
