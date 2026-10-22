import 'reflect-metadata';
import { INestApplication, Module, ValidationPipe, DynamicModule } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppConfig, CONFIG } from './config';
import { DbModule } from './db/db.module';
import { AuthGuard } from './common/auth-context';
import { AllExceptionsFilter } from './common/errors';
import { requestIdMiddleware } from './common/request-id';
import { AuthModule } from './modules/auth/auth';
import { CatalogModule } from './modules/catalog/catalog';
import { TablesModule } from './modules/tables/tables';
import { ShiftsModule } from './modules/shifts/shifts';
import { OrdersModule } from './modules/orders/orders.module';
import { ReportsModule } from './modules/reports/reports';
import { HealthModule } from './modules/health/health';

export function buildAppModule(cfg: AppConfig): DynamicModule {
  @Module({})
  class AppModule {}
  const ConfigModule: DynamicModule = {
    module: class ConfigHolder {},
    global: true,
    providers: [{ provide: CONFIG, useValue: cfg }],
    exports: [CONFIG],
  };
  return {
    module: AppModule,
    imports: [
      ConfigModule,
      DbModule,
      JwtModule.register({ global: true, secret: cfg.jwtSecret, signOptions: { expiresIn: '12h' } }),
      AuthModule, CatalogModule, TablesModule, ShiftsModule, OrdersModule, ReportsModule, HealthModule,
    ],
    providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
  };
}

export async function createApp(cfg: AppConfig): Promise<INestApplication> {
  const app = await NestFactory.create(buildAppModule(cfg), { logger: ['error', 'warn', 'log'] });
  app.use(requestIdMiddleware);
  app.use(helmet());
  app.enableCors({ origin: cfg.corsOrigin, credentials: false });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();

  const doc = new DocumentBuilder()
    .setTitle('POS API').setVersion('1.0').addBearerAuth()
    .setDescription('REST API ugostiteljskog POS sistema. Svi novčani iznosi su decimalni stringovi sa 2 decimale.')
    .build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, doc));
  return app;
}
