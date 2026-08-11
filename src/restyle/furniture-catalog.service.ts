import { Injectable } from '@nestjs/common';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { RoomType } from './prompt-catalog';

const DATA_DIR = join(process.cwd(), 'data');
const IMAGES_DIR = join(DATA_DIR, 'furniture-images');
// Per-product textured-quad GLB (see scripts/generate-furniture-models.js) -
// the real catalog photo baked onto a real-world-sized flat mesh, served at
// /furniture-models for the mobile app's AR placement feature. Not every
// product has one (e.g. products with no scraped width_cm are skipped by
// the generation script), hence the existsSync check in modelUrl below.
const MODELS_DIR = join(DATA_DIR, 'furniture-models');
// Same photos, pre-cropped to just the target furniture piece (via
// scripts/isolate-catalog-photos - see its doc comment) - used as the
// generation reference instead of the full catalog photo, since the raw
// photos are staged lifestyle shots with other furniture/decor in frame
// that would otherwise bleed into the result (confirmed by an A/B test:
// the uncropped photo pulled in a neighboring armchair's color).
const ISOLATED_IMAGES_DIR = join(DATA_DIR, 'furniture-images-isolated');

export interface FurnitureCatalogItem {
  id: string;
  name: string;
  imageUrl: string;
  modelUrl: string | null;
  widthCm: number | null;
  depthCm: number | null;
  heightCm: number | null;
  // Real-world size (meters) of the textured plane built by
  // generate-furniture-models.js - width from scraped dimensions_cm, height
  // from the actual photo's aspect ratio (not dimensions_cm.height) so the
  // mobile app's AR placement (see ArFurniturePlacementPage) doesn't
  // stretch/squash the real photo. Null until that script has run for this
  // product (see ar_plane_meters on the underlying record).
  planeWidthMeters: number | null;
  planeHeightMeters: number | null;
}

interface FurnitureProductRecord {
  filename: string;
  product_name: string;
  category: string;
  dimensions_cm: { width: number; depth: number; height: number } | null;
  ar_plane_meters: { width: number; height: number } | null;
}

// Keys the AR/browse catalog feature can list - a SUPERSET of RoomType, the
// LoRA-relevant type the whole-photo SDXL restyle flow uses. Standalone
// categories like coffee tables aren't tied to a RoomType/LoRA at all (they
// aren't generated via SDXL - they're placed as real AR objects, see
// ArFurniturePlacementPage vs restyle.service.ts), so they live here, NOT in
// prompt-catalog.ts's RoomType. Each entry here must have a real,
// per-product photo catalog on disk (data/furniture-images/<key>/) -
// extend the same way once a new category's catalog data is prepared.
export const CATALOG_KEYS = ['living_room_sofa', 'living_room_sectional', 'living_room_coffee_table'] as const;
export type CatalogKey = (typeof CATALOG_KEYS)[number];

export function isCatalogKey(value: string): value is CatalogKey {
  return (CATALOG_KEYS as readonly string[]).includes(value);
}

@Injectable()
export class FurnitureCatalogService {
  private readonly productsByFilename = new Map<string, FurnitureProductRecord>(
    (JSON.parse(readFileSync(join(DATA_DIR, 'furniture-products.json'), 'utf8')) as FurnitureProductRecord[]).map(
      (p) => [p.filename, p],
    ),
  );

  isSupported(key: CatalogKey): boolean {
    return CATALOG_KEYS.includes(key);
  }

  /** Every real product available to pick from for this catalog key, in stable filename order. */
  listForCatalogKey(key: CatalogKey): FurnitureCatalogItem[] {
    const dir = join(IMAGES_DIR, key);
    if (!existsSync(dir)) return [];

    return readdirSync(dir)
      .filter((f) => !f.startsWith('.'))
      .sort()
      .map((filename) => {
        const product = this.productsByFilename.get(filename);
        const id = filename.replace(/\.[^.]+$/, '');
        const modelPath = join(MODELS_DIR, key, `${id}.glb`);
        return {
          id,
          name: product?.product_name ?? id,
          imageUrl: `/furniture-images/${key}/${filename}`,
          modelUrl: existsSync(modelPath) ? `/furniture-models/${key}/${id}.glb` : null,
          widthCm: product?.dimensions_cm?.width ?? null,
          depthCm: product?.dimensions_cm?.depth ?? null,
          heightCm: product?.dimensions_cm?.height ?? null,
          planeWidthMeters: product?.ar_plane_meters?.width ?? null,
          planeHeightMeters: product?.ar_plane_meters?.height ?? null,
        };
      });
  }

  /**
   * Resolves a chosen product id to the photo used as a generation
   * reference - prefers the isolated (cropped-to-furniture) version, since
   * that's what actually gets sent as an ImagePrompt slot in
   * restyle.service.ts; falls back to the full catalog photo if no isolated
   * version has been prepared for it yet.
   */
  findImagePath(roomType: RoomType, productId: string): string | null {
    const isolatedDir = join(ISOLATED_IMAGES_DIR, roomType);
    if (existsSync(isolatedDir)) {
      const isolatedMatch = readdirSync(isolatedDir).find((f) => f.replace(/\.[^.]+$/, '') === productId);
      if (isolatedMatch) return join(isolatedDir, isolatedMatch);
    }

    const dir = join(IMAGES_DIR, roomType);
    if (!existsSync(dir)) return null;
    const match = readdirSync(dir).find((f) => f.replace(/\.[^.]+$/, '') === productId);
    return match ? join(dir, match) : null;
  }
}
