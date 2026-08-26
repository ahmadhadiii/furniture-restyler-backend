import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UploadedFiles,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { RestyleService } from './restyle.service';
import { isColor, isRoomType } from './prompt-catalog';

class RestyleOverrides {
  prompt?: string;
  denoisingStrength?: string;
  controlnetWeight?: string;
  roomType?: string;
  color?: string;
  roomLength?: string;
  roomWidth?: string;
  roomHeight?: string;
  // Id of a specific real product from GET /furniture-catalog/:catalogKey
  // (e.g. "sofa-003") - when given, that product's own real photo is used
  // as a strong generation reference so the result is nudged toward that
  // specific item rather than the AI improvising a generic one.
  furnitureProductId?: string;
}

@Controller('restyle')
export class RestyleController {
  constructor(private readonly restyleService: RestyleService) {}

  @Post()
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'image', maxCount: 1 },
        { name: 'mask', maxCount: 1 },
        { name: 'additionalPhotos', maxCount: 3 },
      ],
      { limits: { fileSize: 20 * 1024 * 1024 } },
    ),
  )
  async restyle(
    @UploadedFiles()
    files: {
      image?: Express.Multer.File[];
      mask?: Express.Multer.File[];
      additionalPhotos?: Express.Multer.File[];
    },
    @Body() overrides: RestyleOverrides,
  ) {
    const image = files.image?.[0];
    if (!image) {
      throw new BadRequestException('Missing "image" file in multipart form data');
    }
    const mask = files.mask?.[0];

    if (overrides.roomType !== undefined && !isRoomType(overrides.roomType)) {
      throw new BadRequestException(`Invalid "roomType": ${overrides.roomType}`);
    }
    if (overrides.color !== undefined && !isColor(overrides.color)) {
      throw new BadRequestException(`Invalid "color": ${overrides.color}`);
    }

    const dimensions =
      overrides.roomLength && overrides.roomWidth
        ? {
            length: Number(overrides.roomLength),
            width: Number(overrides.roomWidth),
            height: overrides.roomHeight ? Number(overrides.roomHeight) : undefined,
          }
        : undefined;

    const jobId = await this.restyleService.submitRestyle(image.buffer, {
      mask: mask?.buffer,
      prompt: overrides.prompt,
      denoisingStrength: overrides.denoisingStrength ? Number(overrides.denoisingStrength) : undefined,
      controlnetWeight: overrides.controlnetWeight ? Number(overrides.controlnetWeight) : undefined,
      roomType: overrides.roomType,
      color: overrides.color,
      dimensions,
      additionalPhotos: files.additionalPhotos?.map((f) => f.buffer),
      furnitureProductId: overrides.furnitureProductId,
    });
    return { jobId };
  }

  // Polled by the client every few seconds instead of one long-held
  // connection - some tunnels/proxies (e.g. zrok's public share) cut a
  // single request at ~60s, well under how long real generation can take.
  @Get(':jobId')
  async getStatus(@Param('jobId') jobId: string) {
    return this.restyleService.getJobStatus(jobId);
  }
}
