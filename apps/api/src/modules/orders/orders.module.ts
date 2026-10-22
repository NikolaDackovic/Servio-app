import {
  Body, Controller, Delete, Get, HttpCode, Module, Param, ParseUUIDPipe, Patch, Post, Put, Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser, RequirePermissions } from '../../common/auth-context';
import { P } from '../../common/permissions';
import { OrdersService } from './orders.service';
import {
  AddItemDto, CancelOrderDto, CreateOrderDto, CreatePaymentDto, ListOrdersQuery, MergeOrdersDto, MoveItemsDto, RenameOrderDto,
  SetBuyerDto, SetDiscountDto, SettleDto, TransferOrdersDto, UpdateItemDto, VersionDto, VoidItemDto,
} from './orders.dto';

@ApiTags('orders') @ApiBearerAuth()
@Controller('orders')
export class OrdersController {
  constructor(private readonly svc: OrdersService) {}

  @Get() @RequirePermissions(P.ORDER_READ)
  list(@CurrentUser() u: AuthUser, @Query() q: ListOrdersQuery) { return this.svc.list(u, q); }

  @Post() @RequirePermissions(P.ORDER_WRITE)
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateOrderDto) { return this.svc.create(u, dto); }

  @Post('transfer') @HttpCode(200) @RequirePermissions(P.ORDER_WRITE)
  transfer(@CurrentUser() u: AuthUser, @Body() dto: TransferOrdersDto) { return this.svc.transfer(u, dto); }

  @Get(':id/history') @RequirePermissions(P.ORDER_READ)
  history(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.history(u, id); }

  @Get(':id') @RequirePermissions(P.ORDER_READ)
  get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.get(u, id); }

  @Post(':id/items') @RequirePermissions(P.ORDER_WRITE)
  addItem(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AddItemDto) {
    return this.svc.addItem(u, id, dto);
  }

  @Patch(':id/items/:itemId') @RequirePermissions(P.ORDER_WRITE)
  updateItem(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string, @Body() dto: UpdateItemDto) {
    return this.svc.updateItem(u, id, itemId, dto);
  }

  @Delete(':id/items/:itemId') @RequirePermissions(P.ORDER_WRITE)
  removeItem(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string, @Query() dto: VersionDto) {
    return this.svc.removeItem(u, id, itemId, dto);
  }

  @Post(':id/send') @HttpCode(200) @RequirePermissions(P.ORDER_WRITE)
  send(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: VersionDto) {
    return this.svc.send(u, id, dto);
  }

  @Post(':id/items/:itemId/void') @HttpCode(200) @RequirePermissions(P.ORDER_WRITE, P.ORDER_VOID)
  voidItem(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string, @Body() dto: VoidItemDto) {
    return this.svc.voidItem(u, id, itemId, dto);
  }

  @Post(':id/cancel') @HttpCode(200) @RequirePermissions(P.ORDER_WRITE)
  cancel(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelOrderDto) {
    return this.svc.cancel(u, id, dto);
  }

  @Post(':id/settle') @RequirePermissions(P.PAYMENT_CREATE)
  settle(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SettleDto) {
    return this.svc.settle(u, id, dto);
  }

  @Put(':id/discount') @RequirePermissions(P.ORDER_WRITE, P.ORDER_DISCOUNT)
  setDiscount(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetDiscountDto) {
    return this.svc.setDiscount(u, id, dto);
  }

  @Put(':id/buyer') @RequirePermissions(P.ORDER_WRITE)
  setBuyer(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetBuyerDto) {
    return this.svc.setBuyer(u, id, dto);
  }

  @Patch(':id') @RequirePermissions(P.ORDER_WRITE)
  rename(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RenameOrderDto) {
    return this.svc.rename(u, id, dto);
  }

  @Post(':id/move-items') @HttpCode(200) @RequirePermissions(P.ORDER_WRITE)
  moveItems(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: MoveItemsDto) {
    return this.svc.moveItems(u, id, dto);
  }

  @Post(':id/merge') @HttpCode(200) @RequirePermissions(P.ORDER_WRITE)
  merge(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: MergeOrdersDto) {
    return this.svc.merge(u, id, dto);
  }

  @Post(':id/void-all') @HttpCode(200) @RequirePermissions(P.ORDER_WRITE, P.ORDER_VOID)
  voidAll(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: VoidItemDto) {
    return this.svc.voidAll(u, id, dto);
  }

  @Post(':id/payments') @RequirePermissions(P.PAYMENT_CREATE)
  pay(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreatePaymentDto) {
    return this.svc.pay(u, id, dto);
  }
}

@Module({ controllers: [OrdersController], providers: [OrdersService] })
export class OrdersModule {}
