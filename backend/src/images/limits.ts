// Size limit of catalogue images (task M1-T4c; ADR 0011). Shared by the Open
// Food Facts image fetch, the S3 store and GET /catalogue_images/{image_id}.

/**
 * Largest image downloaded, stored or served, in bytes: 1 MiB. Open Food Facts
 * display images (400 pixels) are typically 20 to 100 KiB, so this leaves
 * room for a larger one, while the base64 body of GET /catalogue_images
 * (about 1.4 MB) stays well under the 6 MB Lambda response limit. Stripping
 * never makes an image larger (jpeg.ts), so a downloaded image within the
 * limit is stored within it.
 */
export const MAX_CATALOGUE_IMAGE_BYTES = 1024 * 1024;
