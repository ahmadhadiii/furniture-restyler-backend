// One-off dev tool (not part of the compiled app) - crops every real
// furniture catalog photo in data/furniture-images/<roomType>/ down to just
// the target furniture piece, saving the result into
// data/furniture-images-isolated/<roomType>/. Run whenever a room type's
// catalog photos change or a new room type's catalog is added.
//
// Why: the catalog photos are full staged lifestyle shots (the real
// product page's own photography), often with other furniture/decor
// (an accompanying armchair, a coffee table, wall art) in frame.
// restyle.service.ts uses a chosen product's photo as a high-weight
// ImagePrompt generation reference so the AI leans toward that specific
// item's look - but IP-Adapter conditions on the WHOLE reference image, so
// feeding the full staged photo pulls in that other furniture/decor too,
// not just the target piece. A real A/B test on sofa-003 confirmed this:
// the uncropped photo's neighboring armchair visibly bled its color into
// the generated sofa. Isolating first (via furniture-only segmentation +
// crop to bounding box) fixes that.
//
// Usage: node scripts/isolate-catalog-photos.js <roomType> [roomType...]
// Requires forge-neo running locally (ControlNet /controlnet/detect,
// seg_ofade20k module) - same segmentation backend restyle.service.ts uses.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { PNG } = require('pngjs');

const FORGE_BASE_URL = process.env.A1111_BASE_URL || 'http://localhost:7860';
const DATA_DIR = path.join(__dirname, '..', 'data');
const SRC_ROOT = path.join(DATA_DIR, 'furniture-images');
const DEST_ROOT = path.join(DATA_DIR, 'furniture-images-isolated');

// Standard ADE20K 150-class palette (fixed order) - same table
// restyle module's segmentation.service.ts uses, trimmed here to just what's
// needed to find class 23 (sofa) since that's the only class this script
// isolates (sectionals/corner-sofas are also classified as "sofa" in ADE20K
// - there's no separate sectional class).
const ADE20K_PALETTE = [
  [120,120,120],[180,120,120],[6,230,230],[80,50,50],[4,200,3],[120,120,80],[140,140,140],[204,5,255],[230,230,230],[4,250,7],
  [224,5,255],[235,255,7],[150,5,61],[120,120,70],[8,255,51],[255,6,82],[143,255,140],[204,255,4],[255,51,7],[204,70,3],
  [0,102,200],[61,230,250],[255,6,51],[11,102,255],[255,7,71],[255,9,224],[9,7,230],[220,220,220],[255,9,92],[112,9,255],
  [8,255,214],[7,255,224],[255,184,6],[10,255,71],[255,41,10],[7,255,255],[224,255,8],[102,8,255],[255,61,6],[255,194,7],
  [255,122,8],[0,255,20],[255,8,41],[255,5,153],[6,51,255],[235,12,255],[160,150,20],[0,163,255],[140,140,140],[250,10,15],
  [20,255,0],[31,255,0],[255,31,0],[255,224,0],[153,255,0],[0,0,255],[255,71,0],[0,235,255],[0,173,255],[31,0,255],
  [11,200,200],[255,82,0],[0,255,245],[0,61,255],[0,255,112],[0,255,133],[255,0,0],[255,163,0],[255,102,0],[194,255,0],
  [0,143,255],[51,255,0],[0,82,255],[0,255,41],[0,255,173],[10,0,255],[173,255,0],[0,255,153],[255,92,0],[255,0,255],
];

const SOFA_CLASS = 23;
const MIN_PIXEL_COUNT = 500;
const PADDING_RATIO = 0.04;

function nearestClassId(r, g, b) {
  let best = 0, bestDist = Infinity;
  for (let i = 0; i < ADE20K_PALETTE.length; i++) {
    const [pr, pg, pb] = ADE20K_PALETTE[i];
    const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}

async function isolate(srcPath, destPath) {
  const buf = fs.readFileSync(srcPath);
  const res = await fetch(`${FORGE_BASE_URL}/controlnet/detect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      controlnet_module: 'seg_ofade20k',
      controlnet_input_images: [buf.toString('base64')],
      controlnet_processor_res: 512,
    }),
  });
  const data = await res.json();
  const segBuf = Buffer.from(data.images[0], 'base64');

  const { width, height } = await sharp(buf).metadata();
  const seg = PNG.sync.read(await sharp(segBuf).resize(width, height, { kernel: 'nearest' }).png().toBuffer());

  let minX = width, minY = height, maxX = 0, maxY = 0, count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      if (nearestClassId(seg.data[idx], seg.data[idx + 1], seg.data[idx + 2]) === SOFA_CLASS) {
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (count < MIN_PIXEL_COUNT || maxX <= minX || maxY <= minY) {
    return { ok: false, reason: `too few sofa pixels detected (${count})` };
  }

  const pad = Math.round(Math.min(width, height) * PADDING_RATIO);
  const cropX = Math.max(0, minX - pad);
  const cropY = Math.max(0, minY - pad);
  const cropW = Math.min(width - cropX, maxX - minX + pad * 2);
  const cropH = Math.min(height - cropY, maxY - minY + pad * 2);

  await sharp(buf).extract({ left: cropX, top: cropY, width: cropW, height: cropH }).png().toFile(destPath);
  return { ok: true, cropW, cropH, coveragePct: Math.round((count / (width * height)) * 1000) / 10 };
}

async function main() {
  const roomTypes = process.argv.slice(2);
  if (roomTypes.length === 0) {
    console.error('Usage: node scripts/isolate-catalog-photos.js <roomType> [roomType...]');
    process.exit(1);
  }

  for (const roomType of roomTypes) {
    const srcDir = path.join(SRC_ROOT, roomType);
    if (!fs.existsSync(srcDir)) {
      console.warn(`No catalog photos found for "${roomType}" at ${srcDir}, skipping`);
      continue;
    }
    const destDir = path.join(DEST_ROOT, roomType);
    fs.mkdirSync(destDir, { recursive: true });

    const files = fs.readdirSync(srcDir).filter((f) => !f.startsWith('.'));
    let successCount = 0;
    for (const file of files) {
      const destName = file.replace(/\.[^.]+$/, '.png');
      try {
        const result = await isolate(path.join(srcDir, file), path.join(destDir, destName));
        console.log(roomType, file, '->', JSON.stringify(result));
        if (result.ok) successCount++;
      } catch (error) {
        console.log(roomType, file, '-> ERROR', error.message);
      }
    }

    // This script only isolates ADE20K's SOFA_CLASS (see top of file) - it
    // is NOT a generic per-category isolator. Running it against a room
    // type whose furniture isn't a sofa (e.g. coffee tables) will find ~0
    // sofa pixels in every photo and silently produce an empty (but
    // existing) destDir, which downstream scripts don't distinguish from
    // "successfully isolated nothing because there's nothing here" - this
    // warning is the only signal that something is actually wrong.
    if (files.length > 0 && successCount === 0) {
      console.warn(
        `WARNING: 0 of ${files.length} photos isolated for "${roomType}" - this script only detects ` +
          `ADE20K's sofa class. If this category's furniture isn't a sofa, it either needs its own class ` +
          `ID added here, or (if the source photos are already clean single-item shots with no background ` +
          `clutter) skip this script entirely and copy the photos directly into ` +
          `data/furniture-images-isolated/${roomType}/ instead.`,
      );
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
