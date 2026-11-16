import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, Headers, Param, Patch, Post, Query } from '@nestjs/common';
import {
  CreateOrderRequestSchema,
  CreatePurchaseOrderRequestSchema,
  CreateSupplierRequestSchema,
  LoginRequestSchema,
  PageQueryParamsSchema,
  UpdateSkuRequestSchema,
  UpdateSupplierRequestSchema,
  type CreateOrderRequest,
  type CreatePurchaseOrderRequest,
  type CreateSupplierRequest,
  type LoginRequest,
  type PageQueryParams,
  type Sku,
  type Supplier,
  type UpdateSkuRequest,
  type UpdateSupplierRequest,
} from '@erp/contracts';
import { IamService } from '../../application/iam.service';
import { PurchaseService } from '../../application/purchase.service';
import { SalesService, TENANT_ID } from '../../application/sales.service';
import { DatabasePort, DomainError } from '../../domain/ports';
import { ZodValidationPipe } from './zod-validation.pipe';

@Controller()
export class ErpController {
  constructor(
    private readonly iam: IamService,
    private readonly sales: SalesService,
    private readonly purchase: PurchaseService,
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

  @Get('users/me')
  me(@Headers('authorization') authorization?: string) {
    return this.iam.currentUser(authorization);
  }

  @Get('purchase/suppliers')
  async suppliers(
    @Query(new ZodValidationPipe(PageQueryParamsSchema)) query: PageQueryParams,
  ) {
    return this.db.listSuppliers(query);
  }

  @Post('purchase/suppliers')
  async createSupplier(
    @Body(new ZodValidationPipe(CreateSupplierRequestSchema)) body: CreateSupplierRequest,
  ) {
    const supplier: Supplier = {
      id: randomUUID(),
      tenantId: TENANT_ID,
      code: body.code,
      name: body.name,
      ...(body.contact ? { contact: body.contact } : {}),
      ...(body.phone ? { phone: body.phone } : {}),
      rating: body.rating,
      enabled: true,
    };
    await this.db.saveSupplier(supplier);
    return supplier;
  }

  /** 供应商编辑/停用：saveSupplier 本来就是 upsert，直接合并后保存 */
  @Patch('purchase/suppliers/:id')
  async updateSupplier(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateSupplierRequestSchema)) body: UpdateSupplierRequest,
  ) {
    const found = await this.db.findSupplier(id);
    if (!found) throw new DomainError('NOT_FOUND', `供应商 ${id} 不存在`, 404);
    const merged: Supplier = {
      ...found,
      name: body.name ?? found.name,
      contact: body.contact ?? found.contact,
      phone: body.phone ?? found.phone,
      rating: body.rating ?? found.rating,
      enabled: body.enabled ?? found.enabled,
    };
    await this.db.saveSupplier(merged);
    return merged;
  }

  @Get('purchase/orders')
  async purchaseOrders(
    @Query(new ZodValidationPipe(PageQueryParamsSchema)) query: PageQueryParams,
  ) {
    return this.purchase.listPurchaseOrders(query);
  }

  @Post('purchase/orders')
  createPurchaseOrder(
    @Body(new ZodValidationPipe(CreatePurchaseOrderRequestSchema)) body: CreatePurchaseOrderRequest,
  ) {
    return this.purchase.createPurchaseOrder(body);
  }

  @Post('purchase/orders/:id/submit')
  submitPurchaseOrder(@Param('id') id: string) {
    return this.purchase.submitPurchaseOrder(id);
  }

  @Post('purchase/orders/:id/receive')
  receivePurchaseOrder(@Param('id') id: string) {
    return this.purchase.receivePurchaseOrder(id);
  }

  @Post('purchase/orders/:id/cancel')
  cancelPurchaseOrder(@Param('id') id: string) {
    return this.purchase.cancelPurchaseOrder(id);
  }

  @Get('iam/principals')
  async principals(
    @Query(new ZodValidationPipe(PageQueryParamsSchema)) query: PageQueryParams,
  ) {
    return this.iam.listPrincipals(query);
  }

  @Get('products/skus')
  async skus(
    @Query(new ZodValidationPipe(PageQueryParamsSchema)) query: PageQueryParams,
  ) {
    return this.db.listSkus(query);
  }

  /** SKU 编辑/上下架：照抄供应商内联模式，找不到报 404 */
  @Patch('products/skus/:id')
  async updateSku(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateSkuRequestSchema)) body: UpdateSkuRequest,
  ) {
    const found = await this.db.findSku(id);
    if (!found) throw new DomainError('NOT_FOUND', `SKU ${id} 不存在`, 404);
    const merged: Sku = {
      ...found,
      spec: body.spec ?? found.spec,
      unit: body.unit ?? found.unit,
      enabled: body.enabled ?? found.enabled,
    };
    await this.db.saveSku(merged);
    return merged;
  }

  @Get('inventory/lots')
  async lots(
    @Query(new ZodValidationPipe(PageQueryParamsSchema)) query: PageQueryParams,
  ) {
    return this.db.listLots(query);
  }

  @Get('sales/orders')
  async orders(
    @Query(new ZodValidationPipe(PageQueryParamsSchema)) query: PageQueryParams,
  ) {
    return this.sales.listOrders(query);
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

  @Post('sales/orders/:id/confirm')
  confirm(@Param('id') id: string) {
    return this.sales.confirmOrder(id);
  }

  @Post('sales/orders/:id/cancel')
  cancel(@Param('id') id: string) {
    return this.sales.cancelOrder(id);
  }
}
