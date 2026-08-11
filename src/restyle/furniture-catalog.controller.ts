import { BadRequestException, Controller, Get, Param } from '@nestjs/common';
import { FurnitureCatalogService, isCatalogKey } from './furniture-catalog.service';

@Controller('furniture-catalog')
export class FurnitureCatalogController {
  constructor(private readonly catalog: FurnitureCatalogService) {}

  // Real, individually-pickable products for a catalog key (photo + real
  // scraped dimensions) - only populated for keys with a prepared catalog on
  // disk (see FurnitureCatalogService); an empty array means the app should
  // fall back to the existing color-only flow for that type. Catalog keys
  // are a superset of RoomType - standalone categories like coffee tables
  // aren't a RoomType/LoRA at all, see CatalogKey's doc comment.
  @Get(':catalogKey')
  list(@Param('catalogKey') catalogKey: string) {
    if (!isCatalogKey(catalogKey)) {
      throw new BadRequestException(`Invalid "catalogKey": ${catalogKey}`);
    }
    return this.catalog.listForCatalogKey(catalogKey);
  }
}
