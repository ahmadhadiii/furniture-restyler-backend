export const ROOM_TYPES = ['living_room_sofa', 'living_room_sectional', 'bedroom', 'dining_room'] as const;
export type RoomType = (typeof ROOM_TYPES)[number];

// Room types are being migrated one at a time to their own trigger word and
// their own LoRA (see restyle.service.ts's per-category LORA_*_NAME/WEIGHT
// env vars), trained on category-specific data
// (kohya_ss/datasets/homecenter-furniture-<category>) instead of one shared
// LoRA + shared trigger covering every furniture type. The single shared
// "hmcntrfrn" trigger previously had to disambiguate very different
// furniture (sofas, beds, dining sets) from text alone, which is what
// caused type bleeding - a bedroom request sometimes rendering
// couch/chair-shaped furniture instead of a bed, since the dominant category
// (sofas) had the most training weight under that one token.
//
// All four room types have now been retrained (2026-07/08) onto their own
// dedicated LoRA - FALLBACK_TRIGGER_WORD/the legacy shared LORA_NAME are kept
// only for the no-roomType dev/test-page path (explicit prompt override).
export const FALLBACK_TRIGGER_WORD = 'hmcntrfrn';

export const TRIGGER_WORDS_BY_ROOM_TYPE: Partial<Record<RoomType, string>> = {
  living_room_sofa: 'hmcntrfrn_sofa',
  living_room_sectional: 'hmcntrfrn_sectional',
  bedroom: 'hmcntrfrn_bed',
  dining_room: 'hmcntrfrn_dining',
};

// User-supplied real-world room measurements (meters) - manual input, not
// from a depth sensor/AR scan (this phone isn't ARCore-certified). Used only
// to steer furniture-size wording in the prompt, not to geometrically place
// anything - we have no camera-to-room calibration without real AR data, so
// this can pick a better-fitting furniture size/type, not truly precise
// dimensional placement.
export interface RoomDimensions {
  length: number;
  width: number;
  height?: number;
}

// Wording matches the exact LoRA training captions (kohya_ss/datasets/homecenter-furniture/10_hmcntrfrn_rooms)
// so the model gets scenes it actually saw during training, not paraphrased approximations.
//
// {color} sits directly in front of each specific furniture noun (not as a
// separate leading tag) so it binds tightly to that piece rather than
// drifting onto the wall/room in general - repeated once per distinct piece
// (e.g. bed + nightstands, table + chairs) so multi-item scenes stay
// consistent instead of only coloring the first noun encountered.
//
// {size} sits before the same nouns, for the same reason - only ever
// resolves to a non-empty string for rooms at the small/large extremes (see
// describeSize below), so the common "medium" room case stays byte-for-byte
// the original trained caption.
export const ROOM_TYPE_PROMPTS: Record<RoomType, string> = {
  living_room_sofa:
    'professional interior photo, well-composed living room, single {size}{color}sofa facing a coffee table, rug, tasteful furniture arrangement, non-overlapping furniture',
  living_room_sectional:
    'professional interior photo, well-composed living room, {size}{color}corner sectional sofa with coffee table, tasteful furniture arrangement, non-overlapping furniture',
  bedroom:
    'professional interior photo, well-composed bedroom, {size}{color}bed with {color}nightstands, tasteful furniture arrangement',
  dining_room:
    'professional interior photo, well-composed dining room, {size}{color}dining table with matching {color}chairs evenly spaced, tasteful furniture arrangement',
};

// Area thresholds (m²) per room type - below the low bound gets a "compact"
// treatment, above the high bound gets a "large" treatment, in between
// (the common case) gets no size wording at all. Deliberately conservative:
// only the extremes deviate from the exact trained caption.
//
// The actual size words were checked against real measurements scraped from
// the training photos' source product pages (istikbaliraq.com, see
// data/furniture-products.json in this repo) - every training image is a
// real product with a real listed size. That data ruled out two words we'd
// originally picked without checking: no bed in the training set is under
// 150cm wide (all are 150/160/180cm doubles/queens - there's no true "twin"
// in this catalog), and no dining table is under 200cm (already a 6-8 seat
// table - there's no true "4-seat" table either). Prompting for a furniture
// type the LoRA never actually saw risks the size mismatch this was meant to
// fix, so both now use the same relative compact/large adjectives as the
// living-room categories instead of inventing an unseen furniture class.
const SIZE_THRESHOLDS: Record<RoomType, { low: number; high: number; small: string; large: string }> = {
  living_room_sofa: { low: 14, high: 24, small: 'compact ', large: 'large ' },
  living_room_sectional: { low: 14, high: 24, small: 'compact ', large: 'large ' },
  bedroom: { low: 10, high: 18, small: 'compact ', large: 'large ' },
  dining_room: { low: 10, high: 18, small: 'compact 6-seat ', large: 'large 8-seat ' },
};

export type SizeBucket = 'compact' | 'medium' | 'large';

// Shared by the prompt wording below AND the segmentation mask's dilation
// margin (segmentation.service.ts) - text alone can't make furniture render
// bigger/smaller if the inpaint mask's pixel footprint never changes, so the
// same bucket has to widen/narrow the actual editable region too.
export function describeSizeBucket(roomType: RoomType, dimensions?: RoomDimensions): SizeBucket {
  if (!dimensions?.length || !dimensions?.width) return 'medium';
  const area = dimensions.length * dimensions.width;
  const { low, high } = SIZE_THRESHOLDS[roomType];
  if (area < low) return 'compact';
  if (area > high) return 'large';
  return 'medium';
}

function describeSize(roomType: RoomType, bucket: SizeBucket): string {
  const { small, large } = SIZE_THRESHOLDS[roomType];
  if (bucket === 'compact') return small;
  if (bucket === 'large') return large;
  return '';
}

export const COLORS = ['white', 'cream', 'beige', 'gray', 'black', 'natural_wood'] as const;
export type Color = (typeof COLORS)[number];

export const COLOR_TAGS: Record<Color, string> = {
  white: 'white',
  cream: 'cream',
  beige: 'beige',
  gray: 'gray',
  black: 'black',
  natural_wood: 'natural wood tone',
};

export function isRoomType(value: unknown): value is RoomType {
  return typeof value === 'string' && (ROOM_TYPES as readonly string[]).includes(value);
}

export function isColor(value: unknown): value is Color {
  return typeof value === 'string' && (COLORS as readonly string[]).includes(value);
}

// The prompt the user never sees - built entirely server-side from their
// category picks, not exposed anywhere in the mobile app's request/response.
export function buildCategoryPrompt(roomType: RoomType, color?: Color, dimensions?: RoomDimensions): string {
  const colorPrefix = color ? `${COLOR_TAGS[color]} ` : '';
  const sizePrefix = describeSize(roomType, describeSizeBucket(roomType, dimensions));
  const scene = ROOM_TYPE_PROMPTS[roomType]
    .replaceAll('{color}', colorPrefix)
    .replaceAll('{size}', sizePrefix);
  const trigger = TRIGGER_WORDS_BY_ROOM_TYPE[roomType] ?? FALLBACK_TRIGGER_WORD;
  return `${trigger}, ${scene}, high quality, realistic lighting, photorealistic`;
}
