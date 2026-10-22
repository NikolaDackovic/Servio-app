import { Type } from 'class-transformer';
import {
  IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, Min,
} from 'class-validator';

const AMOUNT_RE = /^\d{1,10}(\.\d{1,2})?$/;
const QTY_RE = /^\d{1,6}(\.\d{1,3})?$/;
const IDEM_RE = /^[A-Za-z0-9._:-]{8,80}$/;

export class VersionDto {
  /** Opciono: verzija porudžbine koju klijent vidi. Ako se ne poklapa → 409 STALE_ORDER. */
  @IsOptional() @IsInt() @Min(0) expectedVersion?: number;
}

export class CreateOrderDto {
  @IsOptional() @IsUUID() tableId?: string;
  @IsOptional() @IsInt() @Min(1) @Max(100) guests?: number;
  @IsOptional() @IsString() @Length(1, 300) note?: string;
  @IsOptional() @Matches(IDEM_RE) idempotencyKey?: string;
}

export class AddItemDto extends VersionDto {
  @IsUUID() productId: string;
  @IsOptional() @Matches(QTY_RE, { message: 'Količina: decimalni broj sa najviše 3 decimale' }) quantity?: string;
  @IsOptional() @IsString() @Length(1, 200) note?: string;
}

export class UpdateItemDto extends VersionDto {
  @IsOptional() @Matches(QTY_RE) quantity?: string;
  @IsOptional() @IsString() @Length(0, 200) note?: string;
}

export class VoidItemDto extends VersionDto {
  @IsString() @Length(3, 200) reason: string;
}

export class CancelOrderDto extends VersionDto {
  @IsString() @Length(3, 200) reason: string;
}

export class CreatePaymentDto {
  @IsIn(['CASH', 'CARD', 'TRANSFER']) method: 'CASH' | 'CARD' | 'TRANSFER';
  /** Iznos koji se primenjuje na račun; ako se izostavi — ceo preostali dug. */
  @IsOptional() @Matches(AMOUNT_RE) amount?: string;
  /** Samo za gotovinu: primljeno od gosta (za obračun kusura). */
  @IsOptional() @Matches(AMOUNT_RE) tendered?: string;
  /** Obavezan: klijent ga generiše jednom po pokušaju naplate i ponavlja ga pri retry-ju. */
  @Matches(IDEM_RE, { message: 'idempotencyKey: 8–80 znakova [A-Za-z0-9._:-]' }) idempotencyKey: string;
  @IsOptional() @IsInt() @Min(0) expectedVersion?: number;
}

export class ListOrdersQuery {
  @IsOptional() @IsIn(['OPEN', 'PAID', 'CANCELLED']) status?: 'OPEN' | 'PAID' | 'CANCELLED';
  @IsOptional() @IsUUID() tableId?: string;
  @IsOptional() @Type(() => Boolean) @IsBoolean() mine?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) pageSize?: number;
}
