import { Injectable } from '@nestjs/common';
import { PNG } from 'pngjs';
import sharp from 'sharp';
import { SizeBucket } from './prompt-catalog';

// How much of the shorter image dimension the mask grows beyond the
// detected furniture's own silhouette, per size bucket. Text-prompt size
// wording ("compact sofa" vs "large sofa") can't actually change how big the
// rendered furniture looks if the inpaint mask's pixel footprint stays fixed
// - Fooocus can only draw within the editable region, so a "large" request
// needs genuinely more room to work with, not just different wording.
// 'medium' (0.075) is the original, already-validated default; compact/large
// widen the range around it rather than replacing it.
const DILATE_RATIO: Record<SizeBucket, number> = {
  compact: 0.055,
  medium: 0.075,
  large: 0.11,
};

// Standard ADE20K 150-class color palette (fixed order), as produced by the
// seg_ofade20k / OneFormer ControlNet preprocessor. Index = class id.
const ADE20K_PALETTE: [number, number, number][] = [
  [120, 120, 120], [180, 120, 120], [6, 230, 230], [80, 50, 50], [4, 200, 3],
  [120, 120, 80], [140, 140, 140], [204, 5, 255], [230, 230, 230], [4, 250, 7],
  [224, 5, 255], [235, 255, 7], [150, 5, 61], [120, 120, 70], [8, 255, 51],
  [255, 6, 82], [143, 255, 140], [204, 255, 4], [255, 51, 7], [204, 70, 3],
  [0, 102, 200], [61, 230, 250], [255, 6, 51], [11, 102, 255], [255, 7, 71],
  [255, 9, 224], [9, 7, 230], [220, 220, 220], [255, 9, 92], [112, 9, 255],
  [8, 255, 214], [7, 255, 224], [255, 184, 6], [10, 255, 71], [255, 41, 10],
  [7, 255, 255], [224, 255, 8], [102, 8, 255], [255, 61, 6], [255, 194, 7],
  [255, 122, 8], [0, 255, 20], [255, 8, 41], [255, 5, 153], [6, 51, 255],
  [235, 12, 255], [160, 150, 20], [0, 163, 255], [140, 140, 140], [250, 10, 15],
  [20, 255, 0], [31, 255, 0], [255, 31, 0], [255, 224, 0], [153, 255, 0],
  [0, 0, 255], [255, 71, 0], [0, 235, 255], [0, 173, 255], [31, 0, 255],
  [11, 200, 200], [255, 82, 0], [0, 255, 245], [0, 61, 255], [0, 255, 112],
  [0, 255, 133], [255, 0, 0], [255, 163, 0], [255, 102, 0], [194, 255, 0],
  [0, 143, 255], [51, 255, 0], [0, 82, 255], [0, 255, 41], [0, 255, 173],
  [10, 0, 255], [173, 255, 0], [0, 255, 153], [255, 92, 0], [255, 0, 255],
  [255, 0, 245], [255, 0, 102], [255, 173, 0], [255, 0, 20], [255, 184, 184],
  [0, 31, 255], [0, 255, 61], [0, 71, 255], [255, 0, 204], [0, 255, 194],
  [0, 255, 82], [0, 10, 255], [0, 112, 255], [51, 0, 255], [0, 194, 255],
  [0, 122, 255], [0, 255, 163], [255, 153, 0], [0, 255, 10], [255, 112, 0],
  [143, 255, 0], [82, 0, 255], [163, 255, 0], [255, 235, 0], [8, 184, 170],
  [133, 0, 255], [0, 255, 92], [184, 0, 255], [255, 0, 31], [0, 184, 255],
  [0, 214, 255], [255, 0, 112], [92, 255, 0], [0, 224, 255], [112, 224, 255],
  [70, 184, 160], [163, 0, 255], [153, 0, 255], [71, 255, 0], [255, 0, 163],
  [255, 204, 0], [255, 0, 143], [0, 255, 235], [133, 255, 0], [255, 0, 235],
  [245, 0, 255], [255, 0, 122], [255, 245, 0], [10, 190, 212], [214, 255, 0],
  [0, 204, 255], [20, 0, 255], [255, 255, 0], [0, 153, 255], [0, 41, 255],
  [0, 255, 204], [41, 0, 255], [41, 255, 0], [173, 0, 255], [0, 245, 255],
  [71, 0, 255], [122, 0, 255], [0, 255, 184], [0, 92, 255], [184, 255, 0],
  [0, 133, 255], [255, 214, 0], [25, 194, 194], [102, 255, 0], [92, 0, 255],
];

// Allow-list, not a deny-list: only pixels the segmentation actually
// recognizes as furniture are editable. Everything else - walls, ceiling,
// floor, rugs, or anything ambiguous/misclassified (e.g. an unusual wall
// covering the segmentation doesn't recognize as "wall") - is protected by
// default. This is the conservative direction: better to under-edit a room
// than accidentally regenerate architecture the model didn't confidently
// classify.
const FURNITURE_CLASS_IDS = new Set<number>([
  7, // bed
  10, // cabinet
  15, // table
  19, // chair
  23, // sofa
  24, // shelf
  30, // armchair
  33, // desk
  35, // wardrobe
  36, // lamp
  39, // cushion
  44, // chest of drawers
  57, // pillow
  62, // bookcase
  64, // coffee table
  69, // bench
  75, // swivel chair
  97, // ottoman
  110, // stool
]);

function nearestClassId(r: number, g: number, b: number): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < ADE20K_PALETTE.length; i++) {
    const [pr, pg, pb] = ADE20K_PALETTE[i];
    const dr = r - pr;
    const dg = g - pg;
    const db = b - pb;
    const dist = dr * dr + dg * dg + db * db;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

@Injectable()
export class SegmentationService {
  /**
   * Turns an ADE20K segmentation map into a black/white inpainting mask:
   * white = recognized furniture (plus a small margin), black = everything
   * else - walls, ceiling, floor, rugs, unrecognized objects. Architecture
   * and floor are never touched; only pixels confidently classified as
   * furniture (and the immediate area around them, so a replacement piece
   * isn't pixel-locked to the old one's exact silhouette) are editable.
   */
  async buildFurnitureMask(
    segmentationPng: Buffer,
    targetWidth: number,
    targetHeight: number,
    sizeBucket: SizeBucket = 'medium',
  ): Promise<Buffer> {
    const seg = PNG.sync.read(segmentationPng);
    const resized = this.resizeNearest(seg, targetWidth, targetHeight);

    const raw = new PNG({ width: targetWidth, height: targetHeight });
    for (let i = 0; i < targetWidth * targetHeight; i++) {
      const idx = i * 4;
      const classId = nearestClassId(resized.data[idx], resized.data[idx + 1], resized.data[idx + 2]);
      const v = FURNITURE_CLASS_IDS.has(classId) ? 255 : 0;
      raw.data[idx] = v;
      raw.data[idx + 1] = v;
      raw.data[idx + 2] = v;
      raw.data[idx + 3] = 255;
    }

    // Grow the detected furniture regions (blur+threshold approximates a
    // morphological dilation) so a differently-shaped/sized replacement piece
    // has real room to fit - too tight (e.g. ~3%) pixel-locks the model to
    // the old item's exact silhouette, producing a same-shape recolor rather
    // than genuinely different furniture. 7-8% gives it room to render an
    // actual sofa shape (armrests, backrest) while still nowhere near as
    // permissive as touching the whole room.
    // blur() and threshold() must run as two separate pipelines (materialize
    // the blur via toBuffer() before thresholding) - chaining them in one
    // sharp pipeline silently under-binarizes (max ends up ~198-251, not
    // 255), so the mask never reaches full opacity and inpainting only
    // partially/weakly edits the region instead of fully replacing it.
    const dilateRadius = Math.max(12, Math.round(Math.min(targetWidth, targetHeight) * DILATE_RATIO[sizeBucket]));
    const blurredBuf = await sharp(PNG.sync.write(raw)).blur(dilateRadius).toBuffer();
    const dilated = await sharp(blurredBuf).threshold(20).toBuffer();

    // Small blur purely to anti-alias the edge, not to grow the region further.
    return sharp(dilated).blur(3).png().toBuffer();
  }

  private resizeNearest(src: PNG, targetWidth: number, targetHeight: number): PNG {
    if (src.width === targetWidth && src.height === targetHeight) {
      return src;
    }
    const out = new PNG({ width: targetWidth, height: targetHeight });
    const scaleX = src.width / targetWidth;
    const scaleY = src.height / targetHeight;
    for (let y = 0; y < targetHeight; y++) {
      const srcY = Math.min(src.height - 1, Math.floor(y * scaleY));
      for (let x = 0; x < targetWidth; x++) {
        const srcX = Math.min(src.width - 1, Math.floor(x * scaleX));
        const srcIdx = (srcY * src.width + srcX) * 4;
        const dstIdx = (y * targetWidth + x) * 4;
        out.data[dstIdx] = src.data[srcIdx];
        out.data[dstIdx + 1] = src.data[srcIdx + 1];
        out.data[dstIdx + 2] = src.data[srcIdx + 2];
        out.data[dstIdx + 3] = 255;
      }
    }
    return out;
  }
}
