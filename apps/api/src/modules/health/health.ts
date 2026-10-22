import { Controller, Get, Inject, Module, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Pool } from 'pg';
import { PG_POOL } from '../../db/db.module';
import { Public } from '../../common/auth-context';
import { FiscalModule, FiscalService } from '../fiscal/fiscal';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool, private readonly fiscal: FiscalService) {}

  @Public() @Get()
  async check() {
    try {
      await this.pool.query('SELECT 1');
    } catch {
      throw new ServiceUnavailableException('Baza podataka nije dostupna');
    }
    return { status: 'ok', database: 'ok', paymentMode: 'TEST', fiscalization: this.fiscal.status(), time: new Date().toISOString() };
  }
}

@Module({ imports: [FiscalModule], controllers: [HealthController] })
export class HealthModule {}
