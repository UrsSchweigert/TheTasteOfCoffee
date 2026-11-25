// JPEG fixtures built in code (no binary blobs, no real metadata from the
// internet). The segments are structurally valid; the "metadata" is made-up
// marker text a test can search for in the output.

export const ascii = (text: string): number[] => Array.from(Buffer.from(text, 'latin1'));

/** A marker segment: FF, marker, 2-byte length (payload + 2), payload. */
export function segment(marker: number, payload: readonly number[]): number[] {
  const length = payload.length + 2;
  return [0xff, marker, length >> 8, length & 0xff, ...payload];
}

export const SOI = [0xff, 0xd8];
export const EOI = [0xff, 0xd9];

/** JFIF APP0 1.02, dpi 72x72, with a 1x1 RGB thumbnail (3 bytes) that must not survive. */
export const APP0_JFIF_WITH_THUMBNAIL = segment(0xe0, [...ascii('JFIF\0'), 1, 2, 1, 0, 72, 0, 72, 1, 1, 0xaa, 0xbb, 0xcc]);
/** JFXX APP0 extension (another thumbnail). */
export const APP0_JFXX = segment(0xe0, [...ascii('JFXX\0'), 0x10, ...ascii('THUMBNAIL-JFXX')]);
/** EXIF APP1 with GPS tag names and a camera serial as plain text. */
export const APP1_EXIF = segment(0xe1, [...ascii('Exif\0\0'), ...ascii('MM\0*GPSLatitude=52.5200N;GPSLongitude=13.4050E;BodySerialNumber=CAM-SECRET-123')]);
/** XMP APP1. */
export const APP1_XMP = segment(0xe1, [...ascii('http://ns.adobe.com/xap/1.0/\0'), ...ascii('<x:xmpmeta><dc:creator>XMP-AUTHOR</dc:creator></x:xmpmeta>')]);
/** ICC profile APP2. */
export const APP2_ICC = segment(0xe2, [...ascii('ICC_PROFILE\0'), 1, 1, ...ascii('ICC-PROFILE-DATA')]);
/** Photoshop / IPTC APP13. */
export const APP13_IPTC = segment(0xed, [...ascii('Photoshop 3.0\0'), ...ascii('8BIM IPTC-BYLINE')]);
/** An Adobe APP14 with flags and colour transform `transform`. */
export const app14Adobe = (transform: number): number[] => segment(0xee, [...ascii('Adobe'), 0x00, 0x65, 0x80, 0x00, 0x12, 0x34, transform]);
/** APP15. */
export const APP15 = segment(0xef, ascii('APP15-DATA'));
/** A comment. */
export const COM = segment(0xfe, ascii('COMMENT-SECRET'));

/** One 8-bit quantisation table, id 0. */
export const DQT = segment(0xdb, [0x00, ...Array.from({ length: 64 }, (_, i) => (i % 50) + 1)]);
/** One DC Huffman table, id 0: two codes of length 1. */
export const DHT = segment(0xc4, [0x00, 2, ...Array.from({ length: 15 }, () => 0), 0x00, 0x01]);
export const DRI = segment(0xdd, [0x00, 0x08]);

/** A frame header: SOF `marker`, 8-bit, the given size, `components` components with 1x1 sampling, table 0. */
export function sof(options: { marker?: number; precision?: number; width?: number; height?: number; components?: number } = {}): number[] {
  const { marker = 0xc0, precision = 8, width = 16, height = 8, components = 3 } = options;
  const parts: number[] = [];
  for (let c = 0; c < components; c += 1) parts.push(c + 1, 0x11, 0);
  return segment(marker, [precision, height >> 8, height & 0xff, width >> 8, width & 0xff, components, ...parts]);
}

/** A scan header for `components` components, then entropy-coded data with a stuffed FF00 and restart markers. */
export function sos(components = 3, data: readonly number[] = [0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff, 0xd7, 0x78]): number[] {
  const parts: number[] = [];
  for (let c = 0; c < components; c += 1) parts.push(c + 1, 0x00);
  return [...segment(0xda, [components, ...parts, 0x00, 0x3f, 0x00]), ...data];
}

/** A minimal valid baseline JPEG: SOI DQT SOF0 DHT SOS data EOI. */
export function minimalJpeg(): Uint8Array {
  return Uint8Array.from([...SOI, ...DQT, ...sof(), ...DHT, ...sos(), ...EOI]);
}

/** A JPEG carrying every kind of metadata the stripper must drop, and trailing data after EOI. */
export function jpegWithMetadata(): Uint8Array {
  return Uint8Array.from([
    ...SOI,
    ...APP0_JFIF_WITH_THUMBNAIL,
    ...APP0_JFXX,
    ...APP1_EXIF,
    ...APP1_XMP,
    ...APP2_ICC,
    ...APP13_IPTC,
    ...app14Adobe(1),
    ...APP15,
    ...COM,
    ...DQT,
    ...sof(),
    ...COM,
    ...DHT,
    ...DRI,
    ...sos(),
    ...EOI,
    ...ascii('TRAILING-SECRET'),
  ]);
}

/** The marker bytes of a JPEG's segments, in order (entropy-coded data skipped). For assertions only. */
export function markersOf(bytes: Uint8Array): number[] {
  const markers: number[] = [];
  let i = 2;
  markers.push(0xd8);
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = bytes[i + 1] ?? 0;
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) {
      i += 2;
      continue;
    }
    markers.push(marker);
    if (marker === 0xd9) break;
    const length = ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0);
    i += 2 + length;
  }
  return markers;
}

export function contains(haystack: Uint8Array, needle: string): boolean {
  return Buffer.from(haystack).includes(Buffer.from(needle, 'latin1'));
}
