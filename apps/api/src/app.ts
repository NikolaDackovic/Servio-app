import path from 'path';
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
import { SettingsModule } from './modules/settings/settings';
import { UsersModule } from './modules/users/users';
import { PricingModule } from './modules/pricing/pricing';
import { DevicesModule } from './modules/devices/devices';
import { ProductInsightsModule } from './modules/catalog/product-insights';
import { OverviewModule } from './modules/overview/overview';
import { ReorderModule } from './modules/stock/reorder';
import { QrModule } from './modules/qr/qr';
import { PaymentChangeModule } from './modules/orders/payment-change';
import { RefundsModule } from './modules/refunds/refunds';
import { SetupModule } from './modules/setup/setup';
import { StockReportsModule } from './modules/stock/stock-reports';
import { ShiftsModule } from './modules/shifts/shifts';
import { OrdersModule } from './modules/orders/orders.module';
import { ReportsModule } from './modules/reports/reports';
import { HealthModule } from './modules/health/health';
import { DayModule } from './modules/day/day';
import { DiscountsModule } from './modules/discounts/discounts';
import { EventsModule } from './common/events';
import { FiscalModule } from './modules/fiscal/fiscal';
import { PrepModule } from './modules/prep/prep';
import { attachRealtime } from './modules/realtime/realtime';
import { StockModule } from './modules/stock/stock';
import { RecipesModule } from './modules/stock/recipes';
import { ImportExportModule } from './modules/stock/import-export';
import { NestExpressApplication } from '@nestjs/platform-express';

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
      EventsModule, FiscalModule, PrepModule, StockModule, RecipesModule, ImportExportModule,
      AuthModule, SetupModule, OverviewModule, ReorderModule, QrModule, PaymentChangeModule, ProductInsightsModule, CatalogModule, TablesModule, SettingsModule, UsersModule, PricingModule, DevicesModule, StockReportsModule, ShiftsModule, OrdersModule, RefundsModule, ReportsModule, HealthModule, DayModule, DiscountsModule,
    ],
    providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
  };
}

export async function createApp(cfg: AppConfig): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(buildAppModule(cfg), { logger: process.env.JEST_WORKER_ID ? ['error'] : process.env.LOG_LEVEL === 'warn' ? ['error', 'warn'] : ['error', 'warn', 'log'] });
  app.useBodyParser('json', { limit: '8mb' }); // uvoz CSV/XLSX (base64) - ostali zahtevi su mali
  app.use(requestIdMiddleware);
  app.use(helmet({
    // Kasa radi i preko http-a u lokalnoj mreži (ADMIN/KDS na drugim uređajima): bez nadogradnje na https i HSTS.
    // Slike izabrane u ADMIN-u (logo, pozadina) prave se preko blob: adresa.
    contentSecurityPolicy: { directives: { upgradeInsecureRequests: null, imgSrc: ["'self'", 'data:', 'blob:'] } },
    hsts: false,
  }));
  app.enableCors({ origin: cfg.corsOrigin, credentials: false });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();

  const doc = new DocumentBuilder()
    .setTitle('POS API').setVersion('1.0').addBearerAuth()
    .setDescription('REST API ugostiteljskog POS sistema. Svi novčani iznosi su decimalni stringovi sa 2 decimale.')
    .build();
  if (process.env.DISABLE_SWAGGER !== '1') SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, doc));
  if (!serveApps(app)) {
    // Razvoj: koren API servera nije aplikacija - kratka stranica sa adresama KASE i ADMIN-a.
    app.getHttpAdapter().get('/', (_req: any, res: any) => res.type('html').send(rootPage()));
  }
  attachRealtime(app);
  return app;
}

/**
 * Instalirana kasa: isti server služi i aplikacije (WEB_DIR = kasa i KDS, ADMIN_DIR = ADMIN pod /admin/).
 * Sve što nije /api ide na index.html (rute aplikacija), da osvežavanje stranice radi.
 */
function serveApps(app: INestApplication): boolean {
  const web = process.env.WEB_DIR, admin = process.env.ADMIN_DIR;
  if (!web && !admin) return false;
  const x = app as NestExpressApplication;
  const ex = x.getHttpAdapter().getInstance();
  const index = (dir: string) => (_req: any, res: any) => res.sendFile(path.join(dir, 'index.html'));
  if (admin) {
    x.useStaticAssets(admin, { prefix: '/admin/', index: false });
    ex.get(/^\/admin(\/.*)?$/, index(admin));
  }
  if (web) {
    x.useStaticAssets(web, { index: false });
    ex.get(/^\/(?!api\/|admin(\/|$)).*/, index(web));
  }
  return true;
}

function rootPage() {
  const link = (href: string, title: string, sub: string) =>
    `<a href="${href}"><b>${title}</b><span>${sub}</span></a>`;
  return `<!doctype html><html lang="sr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>POS server</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:"Segoe UI",system-ui,sans-serif;background:#1b1e23;color:#eef1f5}
main{width:min(440px,100% - 32px)}h1{font-size:20px;margin:0 0 4px}p{color:#98a2b3;margin:0 0 18px;font-size:14px}
a{display:flex;flex-direction:column;gap:2px;padding:14px 16px;margin-bottom:10px;border-radius:8px;background:#262a31;border:1px solid #353b45;color:inherit;text-decoration:none}
a:hover{border-color:#f2b544}a span{color:#98a2b3;font-size:13px}</style></head><body><main>
<h1>POS server radi</h1><p>Ovo je API (podaci). Aplikacije su na sledećim adresama:</p>
${link('http://localhost:5173', 'KASA', 'localhost:5173 - kucanje, naplata, smena')}
${link('http://localhost:5174', 'ADMIN', 'localhost:5174 - proizvodi, cenovnik, izveštaji, podešavanja')}
${link('http://localhost:5173/kds', 'KDS', 'localhost:5173/kds - ekran kuhinje i šanka (PIN kuvara)')}
${link('/api/docs', 'API dokumentacija', 'Swagger')}
</main></body></html>`;
}
