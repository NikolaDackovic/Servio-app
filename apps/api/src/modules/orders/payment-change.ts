import { Body, Controller, HttpCode, Inject, Injectable, Module, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, Matches, ValidateNested } from 'class-validator';
import { and, asc, eq } from 'drizzle-orm';
import { DB, Db } from '../../db/db.module';
import { businessDays, cashShifts, fiscalReceipts, orders, payments } from '../../db/schema';
import { AuthUser, CurrentUser, RequirePermissions } from '../../common/auth-context';
import { P } from '../../common/permissions';
import { audit } from '../../common/audit';
import { Conflict, Invalid, NotFound } from '../../common/errors';
import { EventBus } from '../../common/events';
import { dec, money } from '../../common/money';

class PartDto {
  @IsIn(['CASH', 'CARD', 'TRANSFER']) method: 'CASH' | 'CARD' | 'TRANSFER';
  @Matches(/^\d{1,10}(\.\d{1,2})?$/, { message: 'Iznos: najviše 2 decimale' }) amount: string;
}
class ChangePaymentDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(3) @ValidateNested({ each: true }) @Type(() => PartDto) parts: PartDto[];
}

/**
 * Promena načina plaćanja naplaćenog računa (npr. greškom kartica 4.000 → gotovina 4.000): isti iznos, drugi način.
 * Dozvoljeno dok su poslovni dan i smena kase otvoreni (zaključen pazar se ne menja) i dok račun nema pravi
 * fiskalni račun (tada ide povraćaj + novi račun). Reprezentacija se ne menja ovde. Sve ide u dnevnik.
 */
@Injectable()
export class PaymentChangeService {
  constructor(@Inject(DB) private readonly db: Db, private readonly events: EventBus) {}

  async change(u: AuthUser, orderId: string, dto: ChangePaymentDto) {
    const r = await this.db.transaction(async (tx) => {
      const [o] = await tx.select().from(orders).where(and(eq(orders.id, orderId), eq(orders.locationId, u.locationId))).for('update');
      if (!o) throw NotFound('Račun');
      if (o.status !== 'PAID') throw Conflict('NOT_PAID', 'Način plaćanja se menja samo na naplaćenom računu');
      const old = await tx.select().from(payments).where(eq(payments.orderId, o.id)).orderBy(asc(payments.createdAt));
      if (!old.length) throw Conflict('NO_PAYMENTS', 'Račun nema naplatu');
      if (old.some((p) => p.method === 'REPRESENTATION')) throw Conflict('REPRESENTATION', 'Reprezentacija se ne menja u drugi način plaćanja');
      const [f] = await tx.select().from(fiscalReceipts).where(and(eq(fiscalReceipts.orderId, o.id), eq(fiscalReceipts.transactionType, 'SALE')));
      if (f && f.status !== 'FAILED' && f.provider !== 'TEST' && f.invoiceType !== 'TRAINING') {
        throw Conflict('FISCAL_SIGNED', 'Račun je fiskalizovan - za drugi način plaćanja uradite povraćaj i novi račun');
      }
      const tpl = old[0];
      const [shift] = await tx.select({ status: cashShifts.status }).from(cashShifts).where(eq(cashShifts.id, tpl.shiftId));
      if (shift?.status !== 'OPEN') throw Conflict('SHIFT_CLOSED', 'Smena kase je zatvorena - pazar je zaključen');
      if (tpl.businessDayId) {
        const [d] = await tx.select({ status: businessDays.status }).from(businessDays).where(eq(businessDays.id, tpl.businessDayId));
        if (d?.status !== 'OPEN') throw Conflict('DAY_CLOSED', 'Dan je zatvoren - pazar je zaključen');
      }
      const total = old.reduce((a, p) => a.add(dec(p.amount)), dec(0));
      const parts = dto.parts.filter((p) => dec(p.amount).gt(0));
      const sum = parts.reduce((a, p) => a.add(dec(p.amount)), dec(0));
      if (!parts.length || !sum.eq(total)) throw Invalid('SUM_MISMATCH', `Zbir mora biti ${money(total)} (sada ${money(sum)})`);
      await tx.delete(payments).where(eq(payments.orderId, o.id));
      const stamp = Date.now();
      await tx.insert(payments).values(parts.map((p, i) => ({
        orderId: o.id, shiftId: tpl.shiftId, businessDayId: tpl.businessDayId, staffShiftId: tpl.staffShiftId, deviceId: tpl.deviceId,
        method: p.method, mode: tpl.mode, amount: money(dec(p.amount)), change: '0', idempotencyKey: `chg-${stamp}-${i}`, createdById: u.userId,
      })));
      await tx.update(orders).set({ version: o.version + 1, updatedAt: new Date() }).where(eq(orders.id, o.id));
      await audit(tx, u, 'order.payment.change', 'order', o.id, {
        from: old.map((p) => `${p.method} ${p.amount}`).join(', '), to: parts.map((p) => `${p.method} ${money(dec(p.amount))}`).join(', '),
      });
      return { orderId: o.id, locationId: o.locationId };
    });
    this.events.publish({ type: 'order.updated', locationId: r.locationId, data: { orderId } });
    return { ok: true };
  }
}

@ApiTags('orders') @ApiBearerAuth()
@Controller('orders')
export class PaymentChangeController {
  constructor(private readonly svc: PaymentChangeService) {}
  @Post(':id/payments/change') @HttpCode(200) @RequirePermissions(P.ORDER_REFUND)
  change(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ChangePaymentDto) { return this.svc.change(u, id, dto); }
}

@Module({ controllers: [PaymentChangeController], providers: [PaymentChangeService] })
export class PaymentChangeModule {}
