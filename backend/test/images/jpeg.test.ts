// The JPEG marker rewriter (M1-T4c, D12): structural validation, and that
// every metadata segment (EXIF with GPS, XMP, ICC, IPTC, COM, APP0
// thumbnails, trailing data) is removed while the image data is kept byte for
// byte. Fixtures are built in code (jpeg-fixtures.ts).
import { describe, expect, it } from 'vitest';
import { MAX_JPEG_DIMENSION, stripJpeg } from '../../src/images/jpeg.ts';
import {
  APP0_JFIF_WITH_THUMBNAIL,
  APP1_EXIF,
  COM,
  DHT,
  DQT,
  DRI,
  EOI,
  SOI,
  app14Adobe,
  ascii,
  contains,
  jpegWithMetadata,
  markersOf,
  minimalJpeg,
  segment,
  sof,
  sos,
} from './jpeg-fixtures.ts';

const bytes = (...parts: number[][]): Uint8Array => Uint8Array.from(parts.flat());

describe('stripping', () => {
  it('a minimal JPEG without metadata comes back byte for byte', () => {
    const input = minimalJpeg();
    expect(stripJpeg(input)).toEqual(input);
  });

  it('removes EXIF (with GPS), XMP, ICC, IPTC, APP15, COM, the JFIF thumbnail, JFXX and trailing data', () => {
    const input = jpegWithMetadata();
    const output = stripJpeg(input);
    expect(output).toBeDefined();
    if (output === undefined) return;
    for (const secret of ['Exif', 'GPSLatitude', 'GPSLongitude', 'CAM-SECRET', 'ns.adobe.com/xap', 'XMP-AUTHOR', 'ICC_PROFILE', 'ICC-PROFILE-DATA', 'Photoshop', 'IPTC-BYLINE', 'APP15-DATA', 'COMMENT-SECRET', 'JFXX', 'THUMBNAIL-JFXX', 'TRAILING-SECRET']) {
      expect(contains(output, secret), secret).toBe(false);
    }
    // The JFIF thumbnail pixels are gone with the original APP0.
    expect(Buffer.from(output).includes(Buffer.from([0xaa, 0xbb, 0xcc]))).toBe(false);
    expect(markersOf(output)).toEqual([0xd8, 0xe0, 0xee, 0xdb, 0xc0, 0xc4, 0xdd, 0xda, 0xd9]);
    expect(output.length).toBeLessThan(input.length);
  });

  it('writes a canonical JFIF APP0 (1.01, no density unit, 1:1, no thumbnail) if the input had JFIF', () => {
    const output = stripJpeg(bytes(SOI, APP0_JFIF_WITH_THUMBNAIL, DQT, sof(), DHT, sos(), EOI));
    expect(Array.from(output?.subarray(2, 20) ?? [])).toEqual([0xff, 0xe0, 0x00, 0x10, ...ascii('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  });

  it('writes no APP0 if the input had none, and no APP0 for a non-JFIF APP0', () => {
    expect(markersOf(stripJpeg(minimalJpeg()) ?? new Uint8Array())).not.toContain(0xe0);
    const output = stripJpeg(bytes(SOI, segment(0xe0, ascii('AVI1\0junk')), DQT, sof(), DHT, sos(), EOI));
    expect(markersOf(output ?? new Uint8Array())).toEqual([0xd8, 0xdb, 0xc0, 0xc4, 0xda, 0xd9]);
  });

  it.each([0, 1, 2])('keeps the Adobe colour transform %i in a canonical APP14 without the original flags', (transform) => {
    const output = stripJpeg(bytes(SOI, app14Adobe(transform), DQT, sof({ components: transform === 2 ? 4 : 3 }), DHT, sos(transform === 2 ? 4 : 3), EOI));
    expect(Array.from(output?.subarray(2, 18) ?? [])).toEqual([0xff, 0xee, 0x00, 0x0e, ...ascii('Adobe'), 0x00, 0x64, 0, 0, 0, 0, transform]);
  });

  it('keeps the entropy-coded data byte for byte, with stuffed bytes and restart markers', () => {
    const data = [0x01, 0xff, 0x00, 0xff, 0xd3, 0x02, 0xff, 0x00, 0x03];
    const output = stripJpeg(bytes(SOI, COM, DQT, sof(), DHT, sos(3, data), EOI));
    expect(output).toEqual(bytes(SOI, DQT, sof(), DHT, sos(3, data), EOI));
  });

  it('accepts a progressive JPEG with several scans and tables between them', () => {
    const input = bytes(SOI, DQT, sof({ marker: 0xc2 }), DHT, sos(3), DHT, sos(1), APP1_EXIF, sos(1), EOI);
    const output = stripJpeg(input);
    expect(markersOf(output ?? new Uint8Array())).toEqual([0xd8, 0xdb, 0xc2, 0xc4, 0xda, 0xc4, 0xda, 0xda, 0xd9]);
    expect(contains(output ?? new Uint8Array(), 'GPSLatitude')).toBe(false);
  });

  it('accepts fill bytes before a marker and SOF1, grey and CMYK frames, and the size limit', () => {
    expect(stripJpeg(bytes(SOI, [0xff, 0xff], DQT, sof({ marker: 0xc1 }), DHT, sos(), EOI))).toBeDefined();
    expect(stripJpeg(bytes(SOI, DQT, sof({ components: 1 }), DHT, sos(1), EOI))).toBeDefined();
    expect(stripJpeg(bytes(SOI, DQT, sof({ components: 4 }), DHT, sos(4), EOI))).toBeDefined();
    expect(stripJpeg(bytes(SOI, DQT, sof({ width: MAX_JPEG_DIMENSION, height: MAX_JPEG_DIMENSION }), DHT, sos(), EOI))).toBeDefined();
  });

  it('is never longer than its input', () => {
    for (const input of [minimalJpeg(), jpegWithMetadata(), bytes(SOI, APP0_JFIF_WITH_THUMBNAIL, app14Adobe(0), DQT, sof(), DHT, sos(), EOI)]) {
      expect(stripJpeg(input)?.length ?? Infinity).toBeLessThanOrEqual(input.length);
    }
  });
});

describe('malformed input is no image', () => {
  const scan = (): number[][] => [DQT, sof(), DHT, sos()];
  it.each<[string, Uint8Array]>([
    ['empty', new Uint8Array()],
    ['SOI only', bytes(SOI)],
    ['a PNG', Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ['no SOI', bytes(DQT, sof(), DHT, sos(), EOI)],
    ['no EOI', bytes(SOI, ...scan())],
    ['no SOS', bytes(SOI, DQT, sof(), DHT, EOI)],
    ['no SOF', bytes(SOI, DQT, DHT, sos(), EOI)],
    ['SOS before SOF', bytes(SOI, DQT, DHT, sos(), sof(), EOI)],
    ['two frames', bytes(SOI, DQT, sof(), sof(), DHT, sos(), EOI)],
    ['EOI straight after SOI', bytes(SOI, EOI)],
    ['a second SOI', bytes(SOI, SOI, ...scan(), EOI)],
    ['a restart marker outside a scan', bytes(SOI, [0xff, 0xd0], ...scan(), EOI)],
    ['TEM', bytes(SOI, [0xff, 0x01], ...scan(), EOI)],
    ['a reserved marker', bytes(SOI, segment(0x02, [0]), ...scan(), EOI)],
    ['garbage between segments', bytes(SOI, DQT, [0x00], sof(), DHT, sos(), EOI)],
    ['a segment length of 1', bytes(SOI, [0xff, 0xe1, 0x00, 0x01], ...scan(), EOI)],
    ['a segment running past the end', bytes(SOI, [0xff, 0xe1, 0x40, 0x00, 0x01, 0x02])],
    ['a marker cut off', bytes(SOI, DQT, [0xff])],
    ['entropy data without an end', bytes(SOI, DQT, sof(), DHT, sos(3, [0x01, 0x02, 0x03]))],
    ['entropy data ending in a lone FF', bytes(SOI, DQT, sof(), DHT, sos(3, [0x01, 0xff]))],
    ['lossless SOF3', bytes(SOI, DQT, sof({ marker: 0xc3 }), DHT, sos(), EOI)],
    ['arithmetic SOF9', bytes(SOI, DQT, sof({ marker: 0xc9 }), DHT, sos(), EOI)],
    ['hierarchical SOF5', bytes(SOI, DQT, sof({ marker: 0xc5 }), DHT, sos(), EOI)],
    ['DAC', bytes(SOI, segment(0xcc, [0x00, 0x10]), ...scan(), EOI)],
    ['DNL', bytes(SOI, ...scan(), segment(0xdc, [0x00, 0x08]), EOI)],
    ['JPG reserved C8', bytes(SOI, segment(0xc8, [0]), ...scan(), EOI)],
    ['JPEG-LS (F7)', bytes(SOI, segment(0xf7, [0]), ...scan(), EOI)],
    ['12-bit precision', bytes(SOI, DQT, sof({ precision: 12 }), DHT, sos(), EOI)],
    ['height 0 (DNL)', bytes(SOI, DQT, sof({ height: 0 }), DHT, sos(), EOI)],
    ['width 0', bytes(SOI, DQT, sof({ width: 0 }), DHT, sos(), EOI)],
    ['wider than the limit', bytes(SOI, DQT, sof({ width: MAX_JPEG_DIMENSION + 1 }), DHT, sos(), EOI)],
    ['taller than the limit', bytes(SOI, DQT, sof({ height: MAX_JPEG_DIMENSION + 1 }), DHT, sos(), EOI)],
    ['two components', bytes(SOI, DQT, sof({ components: 2 }), DHT, sos(2), EOI)],
    ['a frame header of the wrong length', bytes(SOI, DQT, segment(0xc0, [8, 0, 8, 0, 16, 3, 1, 0x11, 0]), DHT, sos(), EOI)],
    ['a sampling factor of 0', bytes(SOI, DQT, segment(0xc0, [8, 0, 8, 0, 16, 1, 1, 0x01, 0]), DHT, sos(1), EOI)],
    ['a quantisation table id over 3', bytes(SOI, DQT, segment(0xc0, [8, 0, 8, 0, 16, 1, 1, 0x11, 4]), DHT, sos(1), EOI)],
    ['a scan header of the wrong length', bytes(SOI, DQT, sof(), DHT, segment(0xda, [3, 1, 0, 2, 0, 0, 0x3f, 0]), [0x00], EOI)],
    ['a scan with 0 components', bytes(SOI, DQT, sof(), DHT, segment(0xda, [0, 0, 0x3f, 0]), [0x00], EOI)],
    ['an empty DQT', bytes(SOI, segment(0xdb, []), sof(), DHT, sos(), EOI)],
    ['a short DQT', bytes(SOI, segment(0xdb, [0x00, 1, 2, 3]), sof(), DHT, sos(), EOI)],
    ['a DQT with precision 2', bytes(SOI, segment(0xdb, [0x20, ...Array.from({ length: 64 }, () => 1)]), sof(), DHT, sos(), EOI)],
    ['a DQT with bytes left over', bytes(SOI, segment(0xdb, [0x00, ...Array.from({ length: 65 }, () => 1)]), sof(), DHT, sos(), EOI)],
    ['an empty DHT', bytes(SOI, DQT, sof(), segment(0xc4, []), sos(), EOI)],
    ['a DHT with class 2', bytes(SOI, DQT, sof(), segment(0xc4, [0x20, ...Array.from({ length: 16 }, () => 0)]), sos(), EOI)],
    ['a DHT with too few code values', bytes(SOI, DQT, sof(), segment(0xc4, [0x00, 3, ...Array.from({ length: 15 }, () => 0), 0x00]), sos(), EOI)],
    ['a DHT with more than 256 codes', bytes(SOI, DQT, sof(), segment(0xc4, [0x00, ...Array.from({ length: 16 }, () => 17), ...Array.from({ length: 272 }, () => 0)]), sos(), EOI)],
    ['a DRI of the wrong length', bytes(SOI, DQT, sof(), DHT, segment(0xdd, [0, 8, 0]), sos(), EOI)],
    ['an Adobe transform of 3', bytes(SOI, app14Adobe(3), ...scan(), EOI)],
    ['two Adobe segments that disagree', bytes(SOI, app14Adobe(0), app14Adobe(1), ...scan(), EOI)],
  ])('%s', (_name, input) => {
    expect(stripJpeg(input)).toBeUndefined();
  });

  it('two identical Adobe segments are fine', () => {
    expect(stripJpeg(bytes(SOI, app14Adobe(1), app14Adobe(1), DQT, sof(), DHT, sos(), EOI))).toBeDefined();
  });

  it('an EXIF segment never counts as a frame, even if it contains SOF bytes', () => {
    expect(stripJpeg(bytes(SOI, segment(0xe1, [...ascii('Exif\0\0'), ...sof()]), DQT, DHT, sos(), EOI))).toBeUndefined();
  });

  it('DRI is fine', () => {
    expect(stripJpeg(bytes(SOI, DQT, DRI, sof(), DHT, sos(), EOI))).toBeDefined();
  });
});
