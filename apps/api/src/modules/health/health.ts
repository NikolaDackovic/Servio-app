import { Controller, Get, Inject, Module, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Pool } from 'pg';
import { PG_POOL } from '../../db/db.module';
import { Public } from '../../common/auth-context';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Public() @Get()
  async check() {
    try {
      await this.pool.query('SELECT 1');
    } catch {
      throw new ServiceUnavailableException('Baza podataka nije dostupna');
    }
    return { status: 'ok', database: 'ok', paymentMode: 'TEST', fiscalization: 'NOT_CONFIGURED', time: new Date().toISOString() };
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
