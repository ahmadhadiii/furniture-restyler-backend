import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { RestyleModule } from './restyle/restyle.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Dev test-page, served over the network too (not just openable as a
    // local file) so it's reachable from a phone's browser (e.g. Safari on
    // iPhone, where a native app isn't an option without a Mac/Xcode) via
    // http://<this PC's Tailscale IP>:3000/test-page/.
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'test-page'),
      serveRoot: '/test-page',
    }),
    // Real furniture product photos (data/furniture-images/<roomType>/...),
    // for the mobile app's "pick a specific real product" catalog UI and
    // this same path doubles as the source restyle.service.ts reads from
    // when a furnitureProductId is submitted.
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'data', 'furniture-images'),
      serveRoot: '/furniture-images',
    }),
    // Per-product textured-quad GLB models (see
    // scripts/generate-furniture-models.js) - the real catalog photo baked
    // onto a real-world-sized flat mesh, so the mobile app can place the
    // ACTUAL product as a genuine AR object via augen's NodeType.model,
    // instead of an SDXL-generated approximation.
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'data', 'furniture-models'),
      serveRoot: '/furniture-models',
    }),
    RestyleModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
