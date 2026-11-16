import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, Headers, Param, Patch, Post, Query, UseInterceptors } from '@nestjs/common';
import {
  AuditEventListQuerySchema,
  CreateCustomerRequestSchema,
  CreateOrderRequestSchema,
  CreatePriceRequestSchema,
  CreatePrincipalRequestSchema,
  CreatePurchaseOrderRequestSchema,
  CreateRmaRequestSchema,
  CreateSkuRequestSchema,
  CreateStocktakeRequestSchema,
  CreateSupplierRequestSchema,
  CreateTransferRequestSchema,
  LoginRequestSchema,
  MovementListQuerySchema,
  PageQueryParamsSchema,
  RejectRmaRequestSchema,
  RejectTransferRequestSchema,
  ReportQuerySchema,
  TodoListQuerySchema,
  UpdateCustomerRequestSchema,
  UpdatePriceRequestSchema,
  UpdatePrincipalRequestSchema,
  UpdateSkuRequestSchema,
  UpdateSupplierRequestSchema,
  type AuditEventListQuery,
  type CreateCustomerRequest,
  type CreateOrderRequest,
  type CreatePriceRequest,
  type CreatePrincipalRequest,
  type CreatePurchaseOrderRequest,
  type CreateRmaRequest,
  type CreateSkuRequest,
  type CreateStocktakeRequest,
  type CreateSupplierRequest,
  type CreateTransferRequest,
  type LoginRequest,
  type MovementListQuery,
  type PageQueryParams,
  type RejectRmaRequest,
  type RejectTransferRequest,
  type ReportQuery,
  type Sku,
  type Supplier,
  type TodoListQuery,
  type UpdateCustomerRequest,
  type UpdatePriceRequest,
  type UpdatePrincipalRequest,
  type UpdateSkuRequest,
  type UpdateSupplierRequest,
} from '@erp/contracts';
import { IamService } from '../../application/iam.service';
import { CustomerService } from '../../application/customer.service';
import { DashboardService } from '../../application/dashboard.service';
import { ProductService } from '../../application/product.service';
import { PurchaseService } from '../../application/purchase.service';
import { RmaService } from '../../application/rma.service';
import { SalesService, TENANT_ID } from '../../application/sales.service';
import { StocktakeService } from '../../application/stocktake.service';
import { TransferService } from '../../application/transfer.service';
import { DatabasePort, DomainError } from '../../domain/ports';
import { AuditInterceptor } from './audit.interceptor';
import { ZodValidationPipe } from './zod-validation.pipe';

@Controller()
@UseInterceptors(AuditInterceptor)
export class ErpController {
  constructor(
    private readonly iam: IamService,
    private readonly sales: SalesService,
    private readonly purchase: PurchaseService,
    private readonly product: ProductService,
    private readonly customer: CustomerService,
    private readonly rma: RmaService,
    private readonly transfer: TransferService,
    private readonly stocktake: StocktakeService,
    private readonly dashboard: DashboardService,
    private readonly db: DatabasePort,
  ) {}

  @Get('health')
  health() {
    return { status: 'ok', service: 'erp-api', mode: process.env.DESKTOP_MODE ?? 'demo' };
  }

  /** 仪表盘汇总：聚合页不再拉全量列表 */
  @Get('dashboard/overview')
  overview() {
    return this.dashboard.getOverview();
  }

  @Get('dashboard/report')
  report(
    @Query(new ZodValidationPipe(ReportQuerySchema)) query: ReportQuery,
  ) {
    return this.dashboard.getReport(query.range);
  }

  @Get('dashboard/todos')
  todos(
    @Query(new ZodValidationPipe(TodoListQuerySchema)) query: TodoListQuery,
  ) {
    return this.dashboard.listTodos(query);
  }

  @Get('dashboard/finance-summary')
  financeSummary() {
    return this.dashboard.getFinanceSummary();
  }

  @Get('dashboard/receivables')
  receivables(
    @Query(new ZodValidationPipe(PageQueryParamsSchema)) query: PageQueryParams,
  ) {
    return this.dashboard.listReceivables(query);
  }

  @Get('dashboard/payables')
  payables(
    @Query(new ZodValidationPipe(PageQueryParamsSchema)) query: PageQueryParams,
  ) {
    return this.dashboard.listPayables(query);
  }

  @Get('dashboard/recent-activity')
  recentActivity() {
    return this.dashboard.getRecentActivity();
  }

  @Get('dashboard/movements')
  movements(
    @Query(new ZodValidationPipe(MovementListQuerySchema)) query: MovementListQuery,
  ) {
    return this.dashboard.listMovements(query);
  }

  @Post('auth/login')
  login(@Body(new ZodValidationPipe(LoginRequestSchema)) body: LoginRequest) {
    return this.iam.login(body);
  }

  @Get('users/me')
  me(@Headers('authorization') authorization?: string) {
    return this.iam.currentUser(authorization);
  }

  @Get('customers')
  async customers(
    @Query(new ZodValidationPipe(PageQueryParamsSchema)) query: PageQueryParams,
  ) {
    return this.customer.listCustomers(query);
  }

  @Get('customers/:id')
  async getCustomer(@Param('id') id: string) {
    return this.customer.findCustomer(id);
  }

  @Post('customers')
  createCustomer(
    @Body(new ZodValidationPipe(CreateCustomerRequestSchema)) body: CreateCustomerRequest,
  ) {
    return this.customer.createCustomer(body);
  }

  /** 客户编辑/停用：编码不可改，其余字段按需合并 */
  @Patch('customers/:id')
  updateCustomer(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateCustomerRequestSchema)) body: UpdateCustomerRequest,
  ) {
    return this.customer.updateCustomer(id, body);
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

  @Post('iam/principals')
  createPrincipal(
    @Body(new ZodValidationPipe(CreatePrincipalRequestSchema)) body: CreatePrincipalRequest,
  ) {
    return this.iam.createPrincipal(body);
  }

  /** 改用户：姓名 / 角色 / 密码按需改，用户名不可改 */
  @Patch('iam/principals/:id')
  updatePrincipal(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdatePrincipalRequestSchema)) body: UpdatePrincipalRequest,
  ) {
    return this.iam.updatePrincipal(id, body);
  }

  @Get('products/spus')
  async spus(
    @Query(new ZodValidationPipe(PageQueryParamsSchema)) query: PageQueryParams,
  ) {
    return this.product.listSpus(query);
  }

  @Get('products/skus')
  async skus(
    @Query(new ZodValidationPipe(PageQueryParamsSchema)) query: PageQueryParams,
  ) {
    return this.db.listSkus(query);
  }

  @Post('products/skus')
  createSku(
    @Body(new ZodValidationPipe(CreateSkuRequestSchema)) body: CreateSkuRequest,
  ) {
    return this.product.createSku(body);
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

  @Get('products/prices')
  async prices(
    @Query(new ZodValidationPipe(PageQueryParamsSchema)) query: PageQueryParams,
  ) {
    return this.product.listPrices(query);
  }

  @Post('products/prices')
  createPrice(
    @Body(new ZodValidationPipe(CreatePriceRequestSchema)) body: CreatePriceRequest,
  ) {
    return this.product.createPrice(body);
  }

  /** 改价：只改金额与/或截止时间 */
  @Patch('products/prices/:id')
  updatePrice(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdatePriceRequestSchema)) body: UpdatePriceRequest,
  ) {
    return this.product.updatePrice(id, body);
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

  @Get('rmas')
  async rmas(
    @Query(new ZodValidationPipe(PageQueryParamsSchema)) query: PageQueryParams,
  ) {
    return this.rma.listRmas(query);
  }

  @Get('rmas/:id')
  async getRma(@Param('id') id: string) {
    return this.rma.findRma(id);
  }

  @Post('rmas')
  createRma(
    @Body(new ZodValidationPipe(CreateRmaRequestSchema)) body: CreateRmaRequest,
  ) {
    return this.rma.createRma(body);
  }

  @Post('rmas/:id/approve')
  approveRma(@Param('id') id: string) {
    return this.rma.approveRma(id);
  }

  @Post('rmas/:id/reject')
  rejectRma(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RejectRmaRequestSchema)) body: RejectRmaRequest,
  ) {
    return this.rma.rejectRma(id, body.reason);
  }

  @Post('rmas/:id/receive')
  receiveRma(@Param('id') id: string) {
    return this.rma.receiveRma(id);
  }

  @Post('rmas/:id/refund')
  refundRma(@Param('id') id: string) {
    return this.rma.refundRma(id);
  }

  @Post('rmas/:id/cancel')
  cancelRma(@Param('id') id: string) {
    return this.rma.cancelRma(id);
  }

  @Get('transfers')
  async transfers(
    @Query(new ZodValidationPipe(PageQueryParamsSchema)) query: PageQueryParams,
  ) {
    return this.transfer.listTransfers(query);
  }

  @Get('transfers/:id')
  async getTransfer(@Param('id') id: string) {
    return this.transfer.findTransfer(id);
  }

  @Post('transfers')
  createTransfer(
    @Body(new ZodValidationPipe(CreateTransferRequestSchema)) body: CreateTransferRequest,
  ) {
    return this.transfer.createTransfer(body);
  }

  @Post('transfers/:id/submit')
  submitTransfer(@Param('id') id: string) {
    return this.transfer.submitTransfer(id);
  }

  @Post('transfers/:id/approve')
  approveTransfer(@Param('id') id: string) {
    return this.transfer.approveTransfer(id);
  }

  @Post('transfers/:id/reject')
  rejectTransfer(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RejectTransferRequestSchema)) body: RejectTransferRequest,
  ) {
    return this.transfer.rejectTransfer(id, body.reason);
  }

  @Post('transfers/:id/complete')
  completeTransfer(@Param('id') id: string) {
    return this.transfer.completeTransfer(id);
  }

  @Post('transfers/:id/cancel')
  cancelTransfer(@Param('id') id: string) {
    return this.transfer.cancelTransfer(id);
  }

  @Get('stocktakes')
  async stocktakes(
    @Query(new ZodValidationPipe(PageQueryParamsSchema)) query: PageQueryParams,
  ) {
    return this.stocktake.listStocktakes(query);
  }

  @Get('stocktakes/:id')
  async getStocktake(@Param('id') id: string) {
    return this.stocktake.findStocktake(id);
  }

  @Post('stocktakes')
  createStocktake(
    @Body(new ZodValidationPipe(CreateStocktakeRequestSchema)) body: CreateStocktakeRequest,
  ) {
    return this.stocktake.createStocktake(body);
  }

  @Post('stocktakes/:id/confirm')
  confirmStocktake(@Param('id') id: string) {
    return this.stocktake.confirmStocktake(id);
  }

  @Post('stocktakes/:id/cancel')
  cancelStocktake(@Param('id') id: string) {
    return this.stocktake.cancelStocktake(id);
  }

  /** 操作审计日志列表：entity 精确过滤、action 子串过滤；只读，不记审计 */
  @Get('audit/events')
  async auditEvents(
    @Query(new ZodValidationPipe(AuditEventListQuerySchema)) query: AuditEventListQuery,
  ) {
    return this.db.listAuditEvents(query);
  }
}
