// One-off dev tool (not part of the compiled app) - builds a real-photo
// textured flat-quad GLB per catalog product, so the mobile app can place the
// ACTUAL product photo as a genuine AR object (via augen's NodeType.model)
// instead of an SDXL-generated approximation. See ar-furniture-placement
// discussion: augen's ARNode only supports {sphere, cube, cylinder, model} -
// there's no flat image/plane node type - so a textured quad mesh, exported
// as GLB, is the way to get "the real photo, correctly scaled" onto an AR
// anchor.
//
// Quad sizing: width is set to the product's real scraped width (meters,
// from furniture-products.json dimensions_cm) so the object's on-screen
// footprint is dimensionally accurate for the width axis specifically -
// height then follows the SOURCE IMAGE's own aspect ratio (not the real
// scraped height) so the photo itself isn't stretched/squashed. This is a
// deliberate tradeoff: the isolated catalog photos are a single angled shot,
// not a true front elevation, so forcing both width AND height to match
// scraped real-world numbers would visibly distort the actual photo. The
// numeric fit-check (does this product fit the scanned room?) uses the real
// dimensions_cm directly and does NOT depend on this visual quad's exact
// proportions - only the AR object's visual size is approximated this way.
//
// Usage: node scripts/generate-furniture-models.js <roomType> [roomType...]
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { Document, NodeIO } = require('@gltf-transform/core');

const DATA_DIR = path.join(__dirname, '..', 'data');
const ISOLATED_ROOT = path.join(DATA_DIR, 'furniture-images-isolated');
const MODELS_ROOT = path.join(DATA_DIR, 'furniture-models');
const PRODUCTS_PATH = path.join(DATA_DIR, 'furniture-products.json');

// Longer side cap for the embedded texture - the source catalog photos are
// staged product shots up to ~1700px, which balloons GLB size for no real
// visual benefit at furniture-in-a-room AR viewing distance.
const MAX_TEXTURE_SIDE = 1024;

function loadProducts() {
  const products = JSON.parse(fs.readFileSync(PRODUCTS_PATH, 'utf8'));
  return { products, byFilename: new Map(products.map((p) => [p.filename, p])) };
}

async function buildQuadGlb({ imagePath, widthMeters, realHeightMeters, outPath }) {
  // Trim first - plain product-shot catalog photos (e.g. coffee tables) often
  // have generous uniform-background padding around the item, which would
  // otherwise get baked into the quad's aspect ratio as if it were part of
  // the product (a photo mostly-padding reads as "this item is nearly
  // square" even when the real item is long and low). Harmless no-op on
  // photos that are already tightly cropped (e.g. the sofa isolation
  // pipeline's own bounding-box crop already leaves little to trim).
  const trimmed = await sharp(imagePath).trim().toBuffer();
  const resized = await sharp(trimmed)
    .resize({ width: MAX_TEXTURE_SIDE, height: MAX_TEXTURE_SIDE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 88 })
    .toBuffer();
  const { width: imgW, height: imgH } = await sharp(resized).metadata();
  const heightMeters = widthMeters * (imgH / imgW);
  // Sanity check only - doesn't affect sizing (see file-level comment on why
  // height intentionally follows image aspect, not scraped real height).
  // A big divergence usually means the source crop's aspect ratio is bad
  // (e.g. a tall sliver from a poor segmentation bounding box), which makes
  // the visual AR object look wrong even though its numeric fit-check
  // dimensions stay correct - worth flagging for a manual re-crop.
  const divergence = realHeightMeters ? Math.abs(heightMeters - realHeightMeters) / realHeightMeters : null;
  const suspectCrop = divergence !== null && divergence > 0.5;
  // A bad crop (see comment above) can make the visual object absurdly
  // tall/thin - clamp to a generous 1.5x of the real scraped height so the
  // placed object still looks plausible instead of shipping e.g. a
  // 2.7m-tall floating sofa photo. Only ever shrinks a suspect crop's
  // height; never touches a normal one.
  const clampedHeightMeters =
    suspectCrop && realHeightMeters ? Math.min(heightMeters, realHeightMeters * 1.5) : heightMeters;

  const halfW = widthMeters / 2;
  const doc = new Document();
  const buffer = doc.createBuffer();

  // Bottom-center-anchored vertical quad, normal +Z - so placing this node's
  // origin at an AR floor hit-test point makes the object stand upright on
  // the floor at that point, rather than embedding half of it underground.
  const positions = new Float32Array([
    -halfW, 0, 0,
    halfW, 0, 0,
    halfW, clampedHeightMeters, 0,
    -halfW, clampedHeightMeters, 0,
  ]);
  // glTF texture V=0 is the top of the image, V=1 is the bottom.
  const uvs = new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]);
  const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);

  const positionAccessor = doc.createAccessor().setType('VEC3').setArray(positions).setBuffer(buffer);
  const normalAccessor = doc.createAccessor().setType('VEC3').setArray(normals).setBuffer(buffer);
  const uvAccessor = doc.createAccessor().setType('VEC2').setArray(uvs).setBuffer(buffer);
  const indexAccessor = doc.createAccessor().setType('SCALAR').setArray(indices).setBuffer(buffer);

  const texture = doc.createTexture().setImage(resized).setMimeType('image/jpeg');
  const material = doc
    .createMaterial()
    .setBaseColorTexture(texture)
    .setRoughnessFactor(0.85)
    .setMetallicFactor(0)
    .setDoubleSided(true);

  const primitive = doc
    .createPrimitive()
    .setAttribute('POSITION', positionAccessor)
    .setAttribute('NORMAL', normalAccessor)
    .setAttribute('TEXCOORD_0', uvAccessor)
    .setIndices(indexAccessor)
    .setMaterial(material);

  const mesh = doc.createMesh().addPrimitive(primitive);
  const node = doc.createNode().setMesh(mesh);
  doc.createScene().addChild(node);

  const io = new NodeIO();
  await io.write(outPath, doc);
  return { widthMeters, heightMeters: clampedHeightMeters, suspectCrop };
}

async function main() {
  const roomTypes = process.argv.slice(2);
  if (roomTypes.length === 0) {
    console.error('Usage: node scripts/generate-furniture-models.js <roomType> [roomType...]');
    process.exit(1);
  }

  const { products, byFilename: productsByFilename } = loadProducts();

  for (const roomType of roomTypes) {
    const srcDir = path.join(ISOLATED_ROOT, roomType);
    if (!fs.existsSync(srcDir)) {
      console.warn(`No isolated photos found for "${roomType}" at ${srcDir}, skipping`);
      continue;
    }
    const destDir = path.join(MODELS_ROOT, roomType);
    fs.mkdirSync(destDir, { recursive: true });

    for (const file of fs.readdirSync(srcDir).filter((f) => !f.startsWith('.'))) {
      const id = file.replace(/\.[^.]+$/, '');
      // The isolated file is always saved as .png (see isolate-catalog-photos.js)
      // but the original product record is keyed by the ORIGINAL filename
      // (e.g. sofa-001.webp), so look it up by id, not by extension-matching.
      const product = [...productsByFilename.values()].find((p) => p.filename.replace(/\.[^.]+$/, '') === id);
      const widthCm = product?.dimensions_cm?.width;
      if (!widthCm) {
        console.log(roomType, file, '-> SKIPPED (no real width_cm on record)');
        continue;
      }

      try {
        const result = await buildQuadGlb({
          imagePath: path.join(srcDir, file),
          widthMeters: widthCm / 100,
          realHeightMeters: product?.dimensions_cm?.height ? product.dimensions_cm.height / 100 : null,
          outPath: path.join(destDir, `${id}.glb`),
        });
        console.log(roomType, file, '->', JSON.stringify(result), result.suspectCrop ? '<<< SUSPECT CROP' : '');
        // Persisted so the backend's catalog API can hand these exact
        // numbers to the mobile app for the textured-plane AR path (see
        // furniture-catalog.service.ts) without recomputing (and
        // potentially disagreeing with) the trim+aspect-ratio math above on
        // every request.
        if (product) {
          product.ar_plane_meters = { width: result.widthMeters, height: result.heightMeters };
        }
      } catch (error) {
        console.log(roomType, file, '-> ERROR', error.message);
      }
    }
  }

  fs.writeFileSync(PRODUCTS_PATH, JSON.stringify(products, null, 2));
  console.log(`Saved ar_plane_meters back to ${PRODUCTS_PATH}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
