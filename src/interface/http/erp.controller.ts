import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import {
  CreateOrderRequestSchema,
  LoginRequestSchema,
  type CreateOrderRequest,
  type LoginRequest,
} from '@erp/contracts';
import { IamService } from '../../application/iam.service';
import { SalesService } from '../../application/sales.service';
import { DatabasePort } from '../../domain/ports';
import { ZodValidationPipe } from './zod-validation.pipe';

const page = <T>(items: T[]) => ({
  items,
  total: items.length,
  page: 1,
  pageSize: 20,
});

@Controller()
export class ErpController {
  constructor(
    private readonly iam: IamService,
    private readonly sales: SalesService,
    private readonly db: DatabasePort,
  ) {}

  @Get('health')
  health() {
    return { status: 'ok', service: 'erp-api', mode: process.env.DESKTOP_MODE ?? 'demo' };
  }

  @Post('auth/login')
  login(@Body(new ZodValidationPipe(LoginRequestSchema)) body: LoginRequest) {
    return this.iam.login(body);
  }

  @Get('iam/principals')
  async principals() {
    return page(await this.iam.listPrincipals());
  }

  @Get('products/skus')
  async skus() {
    return page(await this.db.listSkus());
  }

  @Get('inventory/lots')
  async lots() {
    return page(await this.db.listLots());
  }

  @Get('sales/orders')
  async orders() {
    return page(await this.sales.listOrders());
  }

  @Post('sales/orders')
  createOrder(
    @Body(new ZodValidationPipe(CreateOrderRequestSchema)) body: CreateOrderRequest,
  ) {
    return this.sales.createOrder(body);
  }

  @Post('sales/orders/:id/pay')
  pay(@Param('id') id: string) {
    return this.sales.payOrder(id);
  }

  @Post('sales/orders/:id/fulfill')
  fulfill(@Param('id') id: string) {
    return this.sales.fulfillOrder(id);
  }
}
