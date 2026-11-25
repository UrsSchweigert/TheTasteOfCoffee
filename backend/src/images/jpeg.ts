// JPEG validation and metadata stripping (task M1-T4c; D12; ADR 0011). Pure
// TypeScript, no dependency: the marker stream is parsed and written again
// with only what a decoder needs to draw the picture.
//
// Accepted input (anything else is undefined, "no image"):
// - SOI, then marker segments, each with a well-formed length inside the
//   buffer, then EOI. Fill bytes (0xFF) before a marker are allowed.
// - Exactly one frame: SOF0 (baseline), SOF1 (extended sequential) or SOF2
//   (progressive), Huffman-coded, 8-bit precision, 1, 3 or 4 components,
//   width and height from 1 to MAX_JPEG_DIMENSION (a height of 0, which
//   defers it to a DNL marker, is refused). Lossless, arithmetic-coded,
//   hierarchical and 12-bit JPEGs, JPEG-LS and reserved markers are refused:
//   rare in product photos, and not worth the surface.
// - At least one SOS after the frame header; its entropy-coded data runs to
//   the next marker that is not a stuffed 0xFF00 or a restart marker.
// - DQT and DHT tables are checked against their own structure; DRI must be
//   4 bytes long.
//
// Output, in this order: SOI; a fresh JFIF APP0 if the input had a JFIF APP0;
// a fresh Adobe APP14 if the input had one; then every DQT, DHT, DRI, SOF and
// SOS with its entropy-coded data, in input order; EOI.
//
// Dropped:
// - APP1 to APP15 (EXIF with GPS, XMP, ICC profiles, MPF, IPTC/Photoshop
//   APP13, ...) and COM.
// - The input's own APP0 bytes: a JFIF APP0 can carry a thumbnail and the
//   JFXX extension carries more, so it is replaced by a canonical one
//   (version 1.01, no density unit, 1:1, no thumbnail). It is kept at all only
//   because it tells a decoder that three components are YCbCr.
// - The input's own APP14 bytes: replaced by a canonical Adobe segment with
//   only the colour transform copied (0 none, 1 YCbCr, 2 YCCK). Without it a
//   decoder would show Adobe CMYK and RGB JPEGs in the wrong colours.
// - Everything after EOI (trailing data, the extra images of an MPF file).
// Without the ICC profile a wide-gamut image is shown as sRGB; colours may be
// slightly off, which is accepted in exchange for stripping every APPn.

/** Largest width or height accepted, in pixels. Open Food Facts display images are 400 pixels on their long side. */
export const MAX_JPEG_DIMENSION = 4096;

const MARKER = {
  SOF0: 0xc0,
  SOF1: 0xc1,
  SOF2: 0xc2,
  DHT: 0xc4,
  RST0: 0xd0,
  RST7: 0xd7,
  SOI: 0xd8,
  EOI: 0xd9,
  SOS: 0xda,
  DQT: 0xdb,
  DRI: 0xdd,
  APP0: 0xe0,
  APP14: 0xee,
  APP15: 0xef,
  COM: 0xfe,
} as const;

const JFIF_ID = [0x4a, 0x46, 0x49, 0x46, 0x00]; // "JFIF\0"
const ADOBE_ID = [0x41, 0x64, 0x6f, 0x62, 0x65]; // "Adobe"

/** APP0 JFIF 1.01, units 0, density 1:1, no thumbnail. */
const CANONICAL_JFIF = Uint8Array.of(0xff, 0xe0, 0x00, 0x10, ...JFIF_ID, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00);

/** APP14 Adobe, version 100, no flags, the given colour transform. */
function canonicalAdobe(transform: number): Uint8Array {
  return Uint8Array.of(0xff, 0xee, 0x00, 0x0e, ...ADOBE_ID, 0x00, 0x64, 0x00, 0x00, 0x00, 0x00, transform);
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return bytes.length >= prefix.length && prefix.every((byte, index) => bytes[index] === byte);
}

const at = (bytes: Uint8Array, index: number): number => bytes[index] ?? -1;
const u16 = (bytes: Uint8Array, index: number): number => (at(bytes, index) << 8) | at(bytes, index + 1);

/** SOF0/1/2 payload: 8-bit, size within limits, 1, 3 or 4 components with sane sampling and table ids. */
function validFrame(payload: Uint8Array): boolean {
  if (payload.length < 6) return false;
  const precision = at(payload, 0);
  const height = u16(payload, 1);
  const width = u16(payload, 3);
  const components = at(payload, 5);
  if (precision !== 8) return false;
  if (height < 1 || height > MAX_JPEG_DIMENSION || width < 1 || width > MAX_JPEG_DIMENSION) return false;
  if (components !== 1 && components !== 3 && components !== 4) return false;
  if (payload.length !== 6 + 3 * components) return false;
  for (let c = 0; c < components; c += 1) {
    const sampling = at(payload, 7 + 3 * c);
    const h = sampling >> 4;
    const v = sampling & 0x0f;
    if (h < 1 || h > 4 || v < 1 || v > 4 || at(payload, 8 + 3 * c) > 3) return false;
  }
  return true;
}

/** SOS header payload: 1 to 4 components, exact length. */
function validScanHeader(payload: Uint8Array): boolean {
  const components = at(payload, 0);
  return components >= 1 && components <= 4 && payload.length === 1 + 2 * components + 3;
}

/** DQT payload: one or more tables of 64 bytes (8-bit) or 128 bytes (16-bit), ids 0 to 3, nothing left over. */
function validQuantisationTables(payload: Uint8Array): boolean {
  if (payload.length === 0) return false;
  let i = 0;
  while (i < payload.length) {
    const info = at(payload, i);
    const precision = info >> 4;
    if (precision > 1 || (info & 0x0f) > 3) return false;
    i += 1 + 64 * (precision + 1);
  }
  return i === payload.length;
}

/** DHT payload: one or more tables (class 0 or 1, id 0 to 3, at most 256 codes), nothing left over. */
function validHuffmanTables(payload: Uint8Array): boolean {
  if (payload.length === 0) return false;
  let i = 0;
  while (i < payload.length) {
    const info = at(payload, i);
    if (info >> 4 > 1 || (info & 0x0f) > 3) return false;
    if (i + 17 > payload.length) return false;
    let codes = 0;
    for (let k = 1; k <= 16; k += 1) codes += at(payload, i + k);
    if (codes > 256) return false;
    i += 17 + codes;
  }
  return i === payload.length;
}

/** The index of the marker that ends the entropy-coded data starting at `from`, or -1 if the buffer ends first. */
function endOfEntropyData(bytes: Uint8Array, from: number): number {
  for (let i = from; i < bytes.length; i += 1) {
    if (bytes[i] !== 0xff) continue;
    const next = at(bytes, i + 1);
    if (next === -1) return -1;
    if (next === 0x00 || (next >= MARKER.RST0 && next <= MARKER.RST7)) {
      i += 1;
      continue;
    }
    return i;
  }
  return -1;
}

/**
 * The JPEG with all metadata removed, or undefined if the input is not a
 * well-formed JPEG of the accepted kind (see the top of this file). The output
 * is never longer than the input: each canonical segment replaces one at
 * least as long (JFIF 18 bytes, Adobe 16), and everything else is copied or
 * dropped.
 */
export function stripJpeg(input: Uint8Array): Uint8Array | undefined {
  if (at(input, 0) !== 0xff || at(input, 1) !== MARKER.SOI) return undefined;
  const kept: Uint8Array[] = [];
  let jfif = false;
  let adobeTransform: number | undefined;
  let sawFrame = false;
  let sawScan = false;
  let pos = 2;

  for (;;) {
    if (at(input, pos) !== 0xff) return undefined;
    while (at(input, pos) === 0xff) pos += 1;
    const marker = at(input, pos);
    if (marker === -1) return undefined;
    pos += 1;

    if (marker === MARKER.EOI) {
      if (!sawScan) return undefined;
      break;
    }
    // A second SOI, a restart or TEM outside a scan, a stuffed byte, or a
    // reserved marker (0x02 to 0xBF) has no length and does not belong here.
    if (marker < MARKER.SOF0 || (marker >= MARKER.RST0 && marker <= MARKER.SOI)) return undefined;

    const length = u16(input, pos);
    if (length < 2 || pos + length > input.length) return undefined;
    const segment = input.subarray(pos - 2, pos + length);
    const payload = input.subarray(pos + 2, pos + length);
    pos += length;

    if (marker === MARKER.APP0) {
      if (startsWith(payload, JFIF_ID) && payload.length >= 14) jfif = true;
    } else if (marker === MARKER.APP14) {
      if (startsWith(payload, ADOBE_ID) && payload.length >= 12) {
        const transform = at(payload, 11);
        if (transform > 2 || (adobeTransform !== undefined && adobeTransform !== transform)) return undefined;
        adobeTransform = transform;
      }
    } else if ((marker > MARKER.APP0 && marker <= MARKER.APP15) || marker === MARKER.COM) {
      // EXIF, XMP, ICC, IPTC, comments, ...: dropped.
    } else if (marker === MARKER.SOF0 || marker === MARKER.SOF1 || marker === MARKER.SOF2) {
      if (sawFrame || !validFrame(payload)) return undefined;
      sawFrame = true;
      kept.push(segment);
    } else if (marker === MARKER.DHT) {
      if (!validHuffmanTables(payload)) return undefined;
      kept.push(segment);
    } else if (marker === MARKER.DQT) {
      if (!validQuantisationTables(payload)) return undefined;
      kept.push(segment);
    } else if (marker === MARKER.DRI) {
      if (length !== 4) return undefined;
      kept.push(segment);
    } else if (marker === MARKER.SOS) {
      if (!sawFrame || !validScanHeader(payload)) return undefined;
      const end = endOfEntropyData(input, pos);
      if (end === -1) return undefined;
      kept.push(segment, input.subarray(pos, end));
      sawScan = true;
      pos = end;
    } else {
      // Other SOFs (lossless, arithmetic, hierarchical), DAC, DNL, DHP, EXP, JPGn.
      return undefined;
    }
  }

  const header: Uint8Array[] = [Uint8Array.of(0xff, MARKER.SOI)];
  if (jfif) header.push(CANONICAL_JFIF);
  if (adobeTransform !== undefined) header.push(canonicalAdobe(adobeTransform));
  return new Uint8Array(Buffer.concat([...header, ...kept, Uint8Array.of(0xff, MARKER.EOI)]));
}
