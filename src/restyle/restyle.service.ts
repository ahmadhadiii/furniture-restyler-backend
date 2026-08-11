import { Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { imageSize } from 'image-size';
import { createHash, randomUUID } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import sharp from 'sharp';
import { SegmentationService } from './segmentation.service';
import { FurnitureCatalogService } from './furniture-catalog.service';
import { buildCategoryPrompt, Color, describeSizeBucket, RoomDimensions, RoomType } from './prompt-catalog';

// Maps each room type to the env-var prefix holding its own category-specific
// LoRA (see .env: LORA_SOFA_NAME/_WEIGHT, LORA_SECTIONAL_NAME/_WEIGHT,
// LORA_BED_NAME/_WEIGHT, LORA_DINING_NAME/_WEIGHT) - each trained only on
// that furniture type (see prompt-catalog.ts's TRIGGER_WORDS_BY_ROOM_TYPE
// doc comment for why this replaced one shared LoRA covering every
// category). All four room types are covered as of 2026-08.
const LORA_ENV_PREFIX_BY_ROOM_TYPE: Partial<Record<RoomType, string>> = {
  living_room_sofa: 'LORA_SOFA',
  living_room_sectional: 'LORA_SECTIONAL',
  bedroom: 'LORA_BED',
  dining_room: 'LORA_DINING',
};

const DEBUG_DIR = join(process.cwd(), 'debug');

// Jobs older than this are swept on the next submit - a real generation
// finishes in well under this, so anything still around this old was
// abandoned client-side (app closed, network dropped) rather than actually
// still in flight.
const MAX_JOB_AGE_MS = 20 * 60 * 1000;

interface RestyleOverrides {
  mask?: Buffer;
  prompt?: string;
  denoisingStrength?: number;
  controlnetWeight?: number;
  roomType?: RoomType;
  color?: Color;
  dimensions?: RoomDimensions;
  additionalPhotos?: Buffer[];
  furnitureProductId?: string;
}

type JobStatusResult =
  | { status: 'processing' }
  | { status: 'done'; image: string }
  | { status: 'error'; message: string };

interface PendingJob {
  createdAt: number;
  fooocusBaseUrl: string;
  fooocusJobId: string | number;
  original: Buffer;
  mask: Buffer;
  isInpaint: boolean;
  width: number;
  height: number;
  inputHash: string;
  result?: JobStatusResult;
}

@Injectable()
export class RestyleService {
  private readonly logger = new Logger(RestyleService.name);
  // Single-instance backend, so an in-memory map is fine - jobs don't need
  // to survive a restart, and the mobile app always starts a fresh submit
  // after one anyway.
  private readonly jobs = new Map<string, PendingJob>();

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
    private readonly segmentation: SegmentationService,
    private readonly furnitureCatalog: FurnitureCatalogService,
  ) {}

  /**
   * Submits the primary photo for restyling and returns immediately with a
   * job id, rather than blocking until generation finishes - real generation
   * regularly takes 50-70s+, which is longer than some tunnels/proxies (e.g.
   * zrok's public share) will hold a single request open for, causing a
   * client-visible 504 even though the backend keeps working and succeeds
   * fine. Callers poll getJobStatus(jobId) instead, each check being fast
   * regardless of how long the underlying generation takes.
   *
   * Any additionalPhotos (other angles of the same room) are used purely as
   * ImagePrompt reference input - they give the model a better understanding
   * of the room's real materials/lighting/architecture from multiple views,
   * which makes the one generated result more consistent with reality, but
   * they never get their own generation. This is simpler and more reliable
   * than generating a separate result per photo (tried and reverted - even
   * with shared seed and cross-referencing, per-photo results didn't
   * reliably converge on the same furniture design).
   */
  async submitRestyle(buffer: Buffer, overrides: RestyleOverrides = {}): Promise<string> {
    const seed = Math.floor(Math.random() * 2 ** 32);
    // Phone camera photos are frequently stored as sensor-native landscape
    // pixels with an EXIF Orientation tag saying how to rotate them for
    // display (e.g. orientation 6 for a photo taken in portrait) - nothing
    // downstream (imageSize, sharp resize/composite, ADE20K segmentation,
    // Fooocus) looks at that tag, so without correcting for it here, the
    // entire pipeline silently processes a sideways image. That's what
    // caused furniture to land on a wall instead of the floor - the
    // segmentation's idea of "up" was rotated 90 degrees from reality.
    // sharp's rotate() with no args auto-rotates from EXIF and strips the
    // tag, so every buffer used downstream must go through this first.
    const normalizedBuffer = await this.normalizeOrientation(buffer);
    const normalizedAdditionalPhotos = await Promise.all(
      (overrides.additionalPhotos ?? []).slice(0, 3).map((photo) => this.normalizeOrientation(photo)),
    );
    const references = normalizedAdditionalPhotos.map((photo) => ({ image: photo, weight: 0.5 }));
    return this.submitGeneration(normalizedBuffer, references, seed, overrides);
  }

  /** Single, fast, non-blocking status check - never waits on Fooocus itself. */
  async getJobStatus(jobId: string): Promise<JobStatusResult> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new NotFoundException(`Unknown or expired job: ${jobId}`);
    }
    if (job.result) {
      return job.result;
    }

    try {
      const response = await firstValueFrom(
        this.http.get(`${job.fooocusBaseUrl}/v1/generation/query-job`, {
          params: { job_id: job.fooocusJobId, require_step_preview: false },
          timeout: 30_000,
        }),
      );
      const data = response.data;
      // job_stage is the enum to branch on (WAITING/RUNNING/SUCCESS/ERROR);
      // job_status is just a free-text status message, not for control flow.
      if (data?.job_stage === 'SUCCESS') {
        const jobResult = Array.isArray(data?.job_result) ? data.job_result[0] : data?.job_result;
        try {
          job.result = await this.finishJob(job, jobResult);
        } catch (error: any) {
          // finishJob failing (e.g. compositeOverOriginal choking on a
          // corrupt/truncated base64 image from Fooocus) is a real,
          // permanent failure - not the transient polling blip the outer
          // catch below is meant to shrug off. Without this, the exception
          // would be caught there instead and the job would report
          // "processing" forever with no diagnostic, since job.result never
          // gets set.
          this.logger.error(`finishJob failed for job ${jobId}: ${error?.message ?? error}`);
          job.result = { status: 'error', message: `Failed to finish job: ${error?.message ?? error}` };
        }
        return job.result;
      }
      if (data?.job_stage === 'ERROR') {
        job.result = { status: 'error', message: `Fooocus-API job ${job.fooocusJobId} failed: ${JSON.stringify(data)}` };
        return job.result;
      }
      return { status: 'processing' };
    } catch (error: any) {
      // A single transient network blip while polling shouldn't kill the
      // whole job - only Fooocus itself reporting job_stage ERROR (above) is
      // treated as a real failure. Just report "still processing" and let
      // the next poll try again.
      this.logger.warn(`Transient error checking job ${jobId}: ${error?.message ?? error}`);
      return { status: 'processing' };
    }
  }

  private async finishJob(job: PendingJob, jobResult: any): Promise<JobStatusResult> {
    const base64Result: string | undefined = jobResult?.base64;
    if (!base64Result) {
      return { status: 'error', message: `Fooocus-API job finished without an image: ${JSON.stringify(jobResult)}` };
    }
    const generatedImage = base64Result.includes(',') ? base64Result.split(',', 2)[1] : base64Result;

    const outputHash = createHash('sha1').update(generatedImage).digest('hex').slice(0, 12);
    this.logger.log(
      `Got image back. outputHash=${outputHash} (${
        outputHash === job.inputHash ? 'IDENTICAL TO INPUT' : 'differs from input'
      }). finish_reason=${jobResult?.finish_reason}`,
    );

    if (job.isInpaint) {
      // Guarantee protection ourselves by pasting the generated furniture
      // back over the original photo pixel-for-pixel, using our own mask as
      // alpha, regardless of how precisely Fooocus itself composited.
      const composited = await this.compositeOverOriginal(
        job.original,
        Buffer.from(generatedImage, 'base64'),
        job.mask,
        job.width,
        job.height,
      );
      return { status: 'done', image: composited.toString('base64') };
    }

    return { status: 'done', image: generatedImage };
  }

  private sweepStaleJobs(): void {
    const cutoff = Date.now() - MAX_JOB_AGE_MS;
    for (const [id, job] of this.jobs) {
      if (job.createdAt < cutoff) this.jobs.delete(id);
    }
  }

  private normalizeOrientation(buffer: Buffer): Promise<Buffer> {
    return sharp(buffer).rotate().toBuffer();
  }

  /**
   * Resolves which LoRA (and weight) to use for this request - one of the
   * per-category LoRAs (LORA_SOFA_NAME, LORA_BED_NAME, etc.) when a roomType
   * is given, falling back to the old single global LORA_NAME/LORA_WEIGHT
   * for the no-roomType dev/test-page path (explicit prompt override).
   * Fooocus-API's Lora.model_name is a plain string with no filename
   * validation - it silently no-ops if it doesn't exactly match a real file
   * (no error), so the .safetensors extension must be included explicitly.
   */
  private resolveLora(roomType?: RoomType): { name?: string; weight: number } {
    const envPrefix = roomType ? LORA_ENV_PREFIX_BY_ROOM_TYPE[roomType] : undefined;
    const rawName = envPrefix
      ? this.config.get<string>(`${envPrefix}_NAME`)
      : this.config.get<string>('LORA_NAME');
    const name = rawName && !rawName.endsWith('.safetensors') ? `${rawName}.safetensors` : rawName;
    const weight = Number((envPrefix ? this.config.get(`${envPrefix}_WEIGHT`) : this.config.get('LORA_WEIGHT')) ?? 0.8);
    return { name, weight };
  }

  /**
   * Loads the real photo of a specific catalog product the user picked, to
   * use as a strong generation reference - every product in a given
   * category was trained under the exact same generic caption (e.g. "modern
   * sofa, upholstered..."), so the LoRA has no way to distinguish individual
   * products by text alone. The chosen product's own photo, as a
   * higher-weight ImagePrompt reference, is the only real lever available to
   * bias the result toward that specific item rather than a generic one -
   * this nudges style/materials/silhouette toward the real photo, it does
   * not guarantee a pixel-exact reproduction.
   */
  private loadFurnitureProductReference(
    roomType: RoomType | undefined,
    productId: string | undefined,
  ): Buffer | undefined {
    if (!roomType || !productId) return undefined;
    const path = this.furnitureCatalog.findImagePath(roomType, productId);
    if (!path) {
      this.logger.warn(`Unknown furnitureProductId "${productId}" for roomType "${roomType}" - ignoring`);
      return undefined;
    }
    return readFileSync(path);
  }

  private async submitGeneration(
    buffer: Buffer,
    references: { image: Buffer; weight: number }[],
    seed: number,
    overrides: RestyleOverrides,
  ): Promise<string> {
    const base64Image = buffer.toString('base64');
    const { width, height } = this.resolveDimensions(buffer);

    // Same bucket drives both the prompt wording (buildCategoryPrompt below)
    // and how much room the mask actually gives the model to draw into -
    // wording alone can't change the rendered furniture's size if the
    // editable pixel region stays fixed regardless of what's asked for.
    const sizeBucket = overrides.roomType ? describeSizeBucket(overrides.roomType, overrides.dimensions) : 'medium';

    let mask = overrides.mask;
    if (!mask) {
      try {
        const segmentationPng = await this.detectSegmentation(base64Image);
        mask = await this.segmentation.buildFurnitureMask(segmentationPng, width, height, sizeBucket);
        this.dumpDebugImages(buffer, segmentationPng, mask);
      } catch (error: any) {
        this.logger.warn(
          `Auto-segmentation failed, falling back to whole-image ControlNet restyle: ${error?.message ?? error}`,
        );
      }
    }
    const isInpaint = !!mask;

    const { name: loraName, weight: loraWeight } = this.resolveLora(overrides.roomType);
    // Only used by the DEFAULT_PROMPT fallback below (no roomType given) -
    // the normal roomType path embeds its own category trigger directly via
    // buildCategoryPrompt/TRIGGER_WORDS_BY_ROOM_TYPE instead.
    const trigger = this.config.get<string>('TRIGGER_WORDS');

    // The real app sends roomType/color (from a fixed picker, never free text)
    // and the actual prompt is built here, server-side, entirely hidden from
    // the user. An explicit prompt override (dev test-page only) always wins,
    // for bypassing categories entirely when debugging; roomType is the
    // normal path, falling back to DEFAULT_PROMPT only when neither is given.
    const prompt =
      overrides.prompt ??
      (overrides.roomType
        ? buildCategoryPrompt(overrides.roomType, overrides.color, overrides.dimensions)
        : this.config
            .get<string>('DEFAULT_PROMPT', '')
            .replaceAll('{trigger}', trigger ?? ''));

    // Two layers of protection, for two different reasons:
    // 1. We send Fooocus-API the mask as real inpainting (not just a hint) so
    //    generation is conditioned on the untouched surrounding wall/ceiling -
    //    this is what makes the new furniture's lighting/perspective/color
    //    match the room instead of looking like an unrelated photo pasted on
    //    top.
    // 2. Fooocus's own mask compositing still isn't guaranteed pixel-exact, so
    //    our own compositing runs afterward as a hard guarantee that anything
    //    outside the real mask is byte-identical to the original photo.
    const denoisingStrength = overrides.denoisingStrength ?? Number(this.config.get('DENOISING_STRENGTH') ?? 0.85);

    // Fooocus-API always wants a mask for its inpaint-outpaint endpoint; when
    // auto-segmentation didn't produce one, fall back to an all-white
    // (fully editable) mask so behavior matches the old "whole-image restyle"
    // fallback path.
    const rawMaskBuffer = mask ?? (await sharp({
      create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } },
    }).png().toBuffer());
    // Force-resized to width x height like resizedImageBuffer below - a
    // no-op for the auto-segmented mask (already built at this size), but a
    // real fix for a client-supplied overrides.mask (dev/test-page path),
    // which otherwise has no guarantee of matching the generation
    // dimensions and would hit the exact shape-broadcast error described
    // below, just on the mask side instead of the image side.
    const maskBuffer = await sharp(rawMaskBuffer).resize(width, height, { fit: 'fill' }).png().toBuffer();

    // Unlike A1111 (which took explicit width/height fields and resized
    // internally), Fooocus-API pairs input_image and input_mask at whatever
    // raw pixel size each was uploaded at, with no resizing to match them -
    // if they differ, its numpy pipeline fails with a shape-broadcast error.
    // The mask is already built at width x height, so the image must match.
    const resizedImageBuffer = await sharp(buffer).resize(width, height, { fit: 'fill' }).png().toBuffer();

    const loras = loraName ? [{ enabled: true, model_name: loraName, weight: loraWeight }] : [];

    // Structural/style conditioning (Fooocus's Image Prompt / ControlNet
    // mechanism), only engaged when relevant - keeps the default path
    // (no additional photos) byte-for-byte identical to before this feature.
    // cn_img1: the SAME photo being edited, fed again as its own CPDS
    // (depth-like structure) reference - conditions the new furniture on
    // this photo's own perspective/depth for better single-photo realism.
    // Deliberately NOT used for extra angle photos: CPDS/PyraCanny force the
    // output to match the reference's own edge/depth layout pixel-for-pixel,
    // which would be geometrically wrong for a *different* camera angle.
    // cn_img2-4: any additional reference photos of the same room, as
    // ImagePrompt (IP-Adapter) style/content references only - deliberately
    // NOT CPDS/PyraCanny, since a different camera angle's edge/depth layout
    // would be geometrically wrong to force onto this photo. These just give
    // the model a broader view of the room's real materials/lighting so the
    // one result it generates is a better-grounded guess.
    //
    // Fooocus-API caps image_prompts at 4 total slots (Fooocus's own
    // default_controlnet_image_count) - budget: CPDS self-ref (1) + chosen
    // furniture product reference (1, when given) + additional room-angle
    // photos (whatever's left). The product reference takes priority over
    // extra angle photos since picking a specific product is the more
    // deliberate signal.
    const furnitureProductImage = this.loadFurnitureProductReference(
      overrides.roomType,
      overrides.furnitureProductId,
    );
    const remainingSlotsForReferences = 4 - (isInpaint ? 1 : 0) - (furnitureProductImage ? 1 : 0);
    const cnSlots: { image: Buffer; type: string; weight: number }[] = [];
    if (isInpaint) {
      cnSlots.push({ image: resizedImageBuffer, type: 'CPDS', weight: overrides.controlnetWeight ?? 0.5 });
    }
    if (furnitureProductImage) {
      // Higher weight than a plain additional-angle photo (0.5) - this is
      // the main lever this feature has to bias the result toward the
      // specific chosen product rather than a generic one.
      cnSlots.push({ image: furnitureProductImage, type: 'ImagePrompt', weight: 0.75 });
    }
    for (const ref of references.slice(0, Math.max(0, remainingSlotsForReferences))) {
      cnSlots.push({ image: ref.image, type: 'ImagePrompt', weight: ref.weight });
    }

    const advancedParams = {
      inpaint_engine: 'v2.6',
      inpaint_strength: denoisingStrength,
      inpaint_mask_upload_checkbox: true,
      ...(cnSlots.length > 0 ? { mixing_image_prompt_and_inpaint: true } : {}),
    };

    const baseUrl = this.config.get<string>('FOOOCUS_API_BASE_URL');
    const inputHash = createHash('sha1').update(base64Image).digest('hex').slice(0, 12);

    this.logger.log(
      `Sending Fooocus-API inpaint: ${width}x${height}, denoising=${denoisingStrength}, ` +
        `prompt="${prompt}", loras=${JSON.stringify(loras)}, inputHash=${inputHash}, autoMask=${isInpaint}, ` +
        `seed=${seed}, cnSlots=${cnSlots.map((s) => `${s.type}@${s.weight}`).join(',') || 'none'}, ` +
        `furnitureProductId=${overrides.furnitureProductId ?? 'none'}, ` +
        `dimensions=${overrides.dimensions ? JSON.stringify(overrides.dimensions) : 'none'}, sizeBucket=${sizeBucket}`,
    );

    try {
      // V2 (JSON) endpoint, not V1 (multipart form) - verified directly against
      // Fooocus-API's source that the V1 form endpoint's cn_img1-4 fields get
      // parsed but then silently dropped (fooocusapi/utils/api_utils.py:166
      // only forwards image_prompts into the actual generation task for the
      // JSON request classes, not the form one) - so ControlNet/Image-Prompt
      // conditioning is a no-op on V1 regardless of what's submitted. V2 with
      // the same fields genuinely engages it (confirmed: triggers the actual
      // model download and conditioning).
      const payload = {
        input_image: resizedImageBuffer.toString('base64'),
        input_mask: maskBuffer.toString('base64'),
        prompt,
        negative_prompt: this.config.get<string>('NEGATIVE_PROMPT') ?? '',
        performance_selection: this.config.get<string>('PERFORMANCE_SELECTION') ?? 'Quality',
        aspect_ratios_selection: `${width}*${height}`,
        guidance_scale: Number(this.config.get('CFG_SCALE') ?? 7.5),
        image_seed: seed,
        loras,
        advanced_params: advancedParams,
        image_prompts: cnSlots.map((slot) => ({
          cn_img: slot.image.toString('base64'),
          cn_stop: slot.weight,
          cn_weight: slot.weight,
          cn_type: slot.type,
        })),
        async_process: true,
        require_base64: true,
      };

      const submitResponse = await firstValueFrom(
        this.http.post(`${baseUrl}/v2/generation/image-inpaint-outpaint`, payload, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 30_000,
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
        }),
      );

      const fooocusJobId = submitResponse.data?.job_id;
      if (fooocusJobId === undefined || fooocusJobId === null) {
        throw new Error(`Fooocus-API did not return a job_id: ${JSON.stringify(submitResponse.data)}`);
      }

      this.sweepStaleJobs();
      const jobId = randomUUID();
      this.jobs.set(jobId, {
        createdAt: Date.now(),
        fooocusBaseUrl: baseUrl!,
        fooocusJobId,
        original: buffer,
        mask: maskBuffer,
        isInpaint,
        width,
        height,
        inputHash,
      });
      return jobId;
    } catch (error: any) {
      this.logger.error('Failed to call Fooocus-API', error?.stack ?? error);
      throw new InternalServerErrorException(
        `Inference request failed: ${error?.message ?? 'unknown error'}`,
      );
    }
  }

  private async detectSegmentation(base64Image: string): Promise<Buffer> {
    const baseUrl = this.config.get<string>('A1111_BASE_URL');
    const response = await firstValueFrom(
      this.http.post(
        `${baseUrl}/controlnet/detect`,
        {
          controlnet_module: 'seg_ofade20k',
          controlnet_input_images: [base64Image],
          controlnet_processor_res: 512,
        },
        {
          timeout: 120_000,
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
        },
      ),
    );
    const images: string[] | undefined = response.data?.images;
    if (!images?.length) {
      throw new Error('Forge returned no segmentation image');
    }
    return Buffer.from(images[0], 'base64');
  }

  private async compositeOverOriginal(
    original: Buffer,
    generated: Buffer,
    mask: Buffer,
    width: number,
    height: number,
  ): Promise<Buffer> {
    const resizedOriginal = await sharp(original).resize(width, height, { fit: 'fill' }).toBuffer();
    const resizedGenerated = await sharp(generated).resize(width, height, { fit: 'fill' }).toBuffer();
    // Feather the mask edges so the paste blends instead of leaving a hard seam.
    const blurredMaskRaw = await sharp(mask)
      .resize(width, height, { fit: 'fill' })
      .blur(4)
      .grayscale()
      .raw()
      .toBuffer();

    const generatedWithAlpha = await sharp(resizedGenerated)
      .ensureAlpha()
      .joinChannel(blurredMaskRaw, { raw: { width, height, channels: 1 } })
      .png()
      .toBuffer();

    return sharp(resizedOriginal)
      .composite([{ input: generatedWithAlpha, blend: 'over' }])
      .png()
      .toBuffer();
  }

  private dumpDebugImages(original: Buffer, segmentationPng: Buffer, mask: Buffer): void {
    try {
      mkdirSync(DEBUG_DIR, { recursive: true });
      writeFileSync(join(DEBUG_DIR, 'last-original.jpg'), original);
      writeFileSync(join(DEBUG_DIR, 'last-segmentation.png'), segmentationPng);
      writeFileSync(join(DEBUG_DIR, 'last-mask.png'), mask);
    } catch (error: any) {
      this.logger.warn(`Failed to write debug images: ${error?.message ?? error}`);
    }
  }

  private resolveDimensions(buffer: Buffer): { width: number; height: number } {
    const { width, height } = imageSize(buffer);
    if (!width || !height) {
      throw new Error('Could not determine image dimensions');
    }

    const maxSide = 1024;
    const scale = Math.min(1, maxSide / Math.max(width, height));
    const scaledWidth = Math.round((width * scale) / 8) * 8;
    const scaledHeight = Math.round((height * scale) / 8) * 8;

    return { width: scaledWidth || 8, height: scaledHeight || 8 };
  }
}
