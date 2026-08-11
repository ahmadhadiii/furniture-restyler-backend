import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { RestyleController } from './restyle.controller';
import { RestyleService } from './restyle.service';
import { SegmentationService } from './segmentation.service';
import { FurnitureCatalogController } from './furniture-catalog.controller';
import { FurnitureCatalogService } from './furniture-catalog.service';

@Module({
  imports: [HttpModule],
  controllers: [RestyleController, FurnitureCatalogController],
  providers: [RestyleService, SegmentationService, FurnitureCatalogService],
})
export class RestyleModule {}
