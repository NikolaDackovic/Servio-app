import { Type } from 'class-transformer';
import { ValidateNested } from 'class-validator';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, Min,
} from 'class-validator';

const AMOUNT_RE = /^\d{1,10}(\.\d{1,2})?$/;
const QTY_RE = /^\d{1,6}(\.\d{1,3})?$/;
const IDEM_RE = /^[A-Za-z0-9._:-]{8,80}$/;
export type PaymentMethodCode = 'CASH' | 'CARD' | 'TRANSFER' | 'REPRESENTATION';

export class VersionDto {
  /** Opciono: verzija porudžbine koju klijent vidi. Ako se ne poklapa → 409 STALE_ORDER. */
  @IsOptional() @IsInt() @Min(0) expectedVersion?: number;
}

export class CreateOrderDto {
  @IsOptional() @IsUUID() tableId?: string;
  @IsOptional() @IsString() @Length(1, 40) tabName?: string;
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
  @IsIn(['CASH', 'CARD', 'TRANSFER', 'REPRESENTATION']) method: PaymentMethodCode;
  /** Iznos koji se primenjuje na račun; ako se izostavi — ceo preostali dug. */
  @IsOptional() @Matches(AMOUNT_RE) amount?: string;
  /** Samo za gotovinu: primljeno od gosta (za obračun kusura). */
  @IsOptional() @Matches(AMOUNT_RE) tendered?: string;
  /** Obavezan: klijent ga generiše jednom po pokušaju naplate i ponavlja ga pri retry-ju. */
  @Matches(IDEM_RE, { message: 'idempotencyKey: 8–80 znakova [A-Za-z0-9._:-]' }) idempotencyKey: string;
  @IsOptional() @IsInt() @Min(0) expectedVersion?: number;
}

export class ListOrdersQuery {
  @IsOptional() @IsIn(['OPEN', 'PAID', 'CANCELLED', 'MERGED']) status?: 'OPEN' | 'PAID' | 'CANCELLED' | 'MERGED';
  @IsOptional() @IsUUID() tableId?: string;
  @IsOptional() @IsUUID() businessDayId?: string;
  @IsOptional() @IsUUID() waiterId?: string;
  @IsOptional() @Type(() => Boolean) @IsBoolean() mine?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) pageSize?: number;
}

export class TransferOrdersDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @IsUUID('all', { each: true }) orderIds: string[];
  @IsUUID() toUserId: string;
}

export class PaymentPartDto {
  @IsIn(['CASH', 'CARD', 'TRANSFER', 'REPRESENTATION']) method: PaymentMethodCode;
  @IsOptional() @Matches(AMOUNT_RE) amount?: string;
  @IsOptional() @Matches(AMOUNT_RE) tendered?: string;
}

export class SettleDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(4) @ValidateNested({ each: true }) @Type(() => PaymentPartDto) parts: PaymentPartDto[];
  @Matches(IDEM_RE, { message: 'idempotencyKey: 8–80 znakova [A-Za-z0-9._:-]' }) idempotencyKey: string;
  @IsOptional() @IsInt() @Min(0) expectedVersion?: number;
}

export class SetDiscountDto extends VersionDto {
  /** null ili izostavljeno = ukloni popust */
  @IsOptional() @IsUUID() discountId?: string | null;
}

export class SetBuyerDto {
  /** null ili izostavljeno = ukloni kupca */
  @IsOptional() @Matches(/^\d{2}$/) idType?: string | null;
  @IsOptional() @IsString() @Length(1, 40) idValue?: string;
  @IsOptional() @IsString() @Length(1, 60) optionalBasis?: string;
  @IsOptional() @IsString() @Length(1, 60) optionalValue?: string;
}

export class RenameOrderDto {
  @IsOptional() @IsString() @Length(0, 40) tabName?: string;
}

export class MoveItemsDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @IsUUID('all', { each: true }) itemIds: string[];
  /** Postojeći otvoreni račun (tura) */
  @IsOptional() @IsUUID() toOrderId?: string;
  /** Ili: nova tura na ovom stolu (podrazumevano isti sto kao izvor) */
  @IsOptional() @IsUUID() toTableId?: string;
  @IsOptional() @IsString() @Length(0, 40) toTabName?: string;
}

export class MergeOrdersDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @IsUUID('all', { each: true }) fromOrderIds: string[];
}
