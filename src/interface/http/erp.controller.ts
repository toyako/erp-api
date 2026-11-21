import { randomUUID } from 'node:crypto';
import { Body, Controller, Delete, Get, Headers, Param, Patch, Post, Query, Req, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  AuditEventListQuerySchema,
  CreateCategoryRequestSchema,
  CreateCustomerFollowupRequestSchema,
  CreateCustomerRequestSchema,
  CreateExchangeRequestSchema,
  CreateInvoiceRequestSchema,
  CreateOrderRequestSchema,
  CreatePriceRequestSchema,
  CreatePrincipalRequestSchema,
  CreatePriceTierRequestSchema,
  CreatePurchaseOrderRequestSchema,
  CreateRmaRequestSchema,
  CreateShipmentRequestSchema,
  CreateSkuRequestSchema,
  CreateStocktakeRequestSchema,
  CreateSupplierRequestSchema,
  CreateTransferRequestSchema,
  CreateWarehouseRequestSchema,
  GoodsReceiptListQuerySchema,
  LoginRequestSchema,
  MovementListQuerySchema,
  PageQueryParamsSchema,
  PriceTierListQuerySchema,
  ReceivePurchaseOrderRequestSchema,
  RejectPurchaseOrderRequestSchema,
  ResolvePriceQuerySchema,
  RejectExchangeRequestSchema,
  RejectRmaRequestSchema,
  RejectTransferRequestSchema,
  ReportQuerySchema,
  ShipShipmentRequestSchema,
  TodoListQuerySchema,
  TopupRequestSchema,
  UpdateApprovalRuleRequestSchema,
  UpdateCategoryRequestSchema,
  UpdateCustomerFollowupRequestSchema,
  UpdateCustomerRequestSchema,
  UpdateLevelRuleRequestSchema,
  UpdatePriceRequestSchema,
  UpdatePriceTierRequestSchema,
  UpdateWarehouseRequestSchema,
  UpdatePrincipalRequestSchema,
  UpdateSkuRequestSchema,
  UpdateSupplierRequestSchema,
  type AuditEventListQuery,
  type CreateCategoryRequest,
  type CreateCustomerFollowupRequest,
  type CreateCustomerRequest,
  type CreateExchangeRequest,
  type CreateInvoiceRequest,
  type CreateOrderRequest,
  type CreatePriceRequest,
  type CreatePrincipalRequest,
  type CreatePriceTierRequest,
  type CreatePurchaseOrderRequest,
  type CreateRmaRequest,
  type CreateShipmentRequest,
  type CreateSkuRequest,
  type CreateStocktakeRequest,
  type CreateSupplierRequest,
  type CreateTransferRequest,
  type CreateWarehouseRequest,
  type GoodsReceiptListQuery,
  type LoginRequest,
  type MovementListQuery,
  type PageQueryParams,
  type PriceTierListQuery,
  type ReceivePurchaseOrderRequest,
  type RejectPurchaseOrderRequest,
  type ResolvePriceQuery,
  type RejectExchangeRequest,
  type RejectRmaRequest,
  type RejectTransferRequest,
  type ReportQuery,
  type ShipShipmentRequest,
  type Sku,
  type Supplier,
  type TodoListQuery,
  type TopupRequest,
  type UpdateApprovalRuleRequest,
  type UpdateCategoryRequest,
  type UpdateCustomerFollowupRequest,
  type UpdateCustomerRequest,
  type UpdateLevelRuleRequest,
  type UpdatePriceRequest,
  type UpdatePriceTierRequest,
  type UpdateWarehouseRequest,
  type UpdatePrincipalRequest,
  type UpdateSkuRequest,
  type UpdateSupplierRequest,
} from '@erp/contracts';
import { IamService } from '../../application/iam.service';
import { ApprovalRuleService } from '../../application/approval-rule.service';
import { CategoryService } from '../../application/category.service';
import { CustomerService } from '../../application/customer.service';
import { DashboardService } from '../../application/dashboard.service';
import { ExchangeService } from '../../application/exchange.service';
import { PriceTierService } from '../../application/price-tier.service';
import { ProductService } from '../../application/product.service';
import { PurchaseService } from '../../application/purchase.service';
import { RmaService } from '../../application/rma.service';
import { SalesService, TENANT_ID } from '../../application/sales.service';
import { ShipmentService } from '../../application/shipment.service';
import { InvoiceService } from '../../application/invoice.service';
import { ImportService } from '../../application/import.service';
import { StocktakeService } from '../../application/stocktake.service';
import { TransferService } from '../../application/transfer.service';
import { WarehouseService } from '../../application/warehouse.service';
import { DatabasePort, DomainError } from '../../domain/ports';
import { AuditInterceptor } from './audit.interceptor';
import { Public } from './auth.guard';
import { ZodValidationPipe } from './zod-validation.pipe';

@Controller()
@UseInterceptors(AuditInterceptor)
export class ErpController {
  constructor(
    private readonly iam: IamService,
    private readonly sales: SalesService,
    private readonly purchase: PurchaseService,
    private readonly product: ProductService,
    private readonly category: CategoryService,
    private readonly priceTier: PriceTierService,
    private readonly warehouse: WarehouseService,
    private readonly customer: CustomerService,
    private readonly rma: RmaService,
    private readonly shipment: ShipmentService,
    private readonly invoice: InvoiceService,
    private readonly transfer: TransferService,
    private readonly stocktake: StocktakeService,
    private readonly approvalRule: ApprovalRuleService,
    private readonly exchange: ExchangeService,
    private readonly importer: ImportService,
    private readonly dashboard: DashboardService,
    private readonly db: DatabasePort,
  ) {}

  @Public()
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

  @Get('dashboard/purchase-report')
  purchaseReport(
    @Query(new ZodValidationPipe(ReportQuerySchema)) query: ReportQuery,
  ) {
    return this.dashboard.getPurchaseReport(query.range);
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

  @Public()
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

  /** 客户充值：加预存款余额并记流水 */
  @Post('customers/:id/topup')
  topupCustomer(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(TopupRequestSchema)) body: TopupRequest,
  ) {
    return this.customer.topupCustomer(id, body);
  }

  /** 客户余额流水：按创建时间倒序 */
  @Get('customers/:id/balance-txs')
  balanceTransactions(
    @Param('id') id: string,
    @Query(new ZodValidationPipe(PageQueryParamsSchema)) query: PageQueryParams,
  ) {
    return this.customer.listBalanceTransactions(id, query);
  }

  /** 客户跟进列表：按创建时间倒序 */
  @Get('customers/:id/followups')
  followups(
    @Param('id') id: string,
    @Query(new ZodValidationPipe(PageQueryParamsSchema)) query: PageQueryParams,
  ) {
    return this.customer.listFollowups(id, query);
  }

  /** 新建跟进记录 */
  @Post('customers/:id/followups')
  createFollowup(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(CreateCustomerFollowupRequestSchema)) body: CreateCustomerFollowupRequest,
  ) {
    return this.customer.createFollowup(id, body);
  }

  /** 改跟进记录（内容/下次跟进时间/完成标记） */
  @Patch('customers/followups/:id')
  updateFollowup(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateCustomerFollowupRequestSchema)) body: UpdateCustomerFollowupRequest,
  ) {
    return this.customer.updateFollowup(id, body);
  }

  /** 等级规则列表：按门槛升序（顶级路径，避免与 customers/:id 冲突） */
  @Get('customer-level-rules')
  levelRules() {
    return this.customer.listLevelRules();
  }

  /** 改等级门槛：只改门槛金额，不批量重评现有客户（下次订单事件时生效） */
  @Patch('customer-level-rules/:level')
  updateLevelRule(
    @Param('level') level: string,
    @Body(new ZodValidationPipe(UpdateLevelRuleRequestSchema)) body: UpdateLevelRuleRequest,
  ) {
    return this.customer.updateLevelRule(level, body);
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

  @Post('purchase/orders/:id/approve')
  approvePurchaseOrder(
    @Param('id') id: string,
    @Req() req: { user?: { roles?: string[] } },
  ) {
    return this.purchase.approvePurchaseOrder(id, req.user?.roles ?? []);
  }

  @Post('purchase/orders/:id/reject')
  rejectPurchaseOrder(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RejectPurchaseOrderRequestSchema)) body: RejectPurchaseOrderRequest,
  ) {
    return this.purchase.rejectPurchaseOrder(id, body.reason);
  }

  @Post('purchase/orders/:id/receive')
  receivePurchaseOrder(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ReceivePurchaseOrderRequestSchema)) body: ReceivePurchaseOrderRequest,
  ) {
    return this.purchase.receivePurchaseOrder(id, body);
  }

  @Post('purchase/orders/:id/cancel')
  cancelPurchaseOrder(@Param('id') id: string) {
    return this.purchase.cancelPurchaseOrder(id);
  }

  @Get('purchase/receipts')
  purchaseReceipts(
    @Query(new ZodValidationPipe(PageQueryParamsSchema)) query: PageQueryParams,
    @Query(new ZodValidationPipe(GoodsReceiptListQuerySchema)) filter: GoodsReceiptListQuery,
  ) {
    return this.purchase.listReceipts(query, filter.purchaseOrderId);
  }

  @Get('purchase/receipts/:id')
  async purchaseReceipt(@Param('id') id: string) {
    const receipt = await this.purchase.findReceipt(id);
    if (!receipt) throw new DomainError('NOT_FOUND', `入库单 ${id} 不存在`, 404);
    return receipt;
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
    // cost 传 null 表示清除成本价（回未维护），须用 !== undefined 判，不能用 ??（null 会被 ?? 吞掉）
    if (body.cost !== undefined) merged.cost = body.cost;
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

  @Get('product/categories')
  async categoryTree() {
    return this.category.listTree();
  }

  @Post('product/categories')
  createCategory(
    @Body(new ZodValidationPipe(CreateCategoryRequestSchema)) body: CreateCategoryRequest,
  ) {
    return this.category.createCategory(body);
  }

  @Patch('product/categories/:id')
  updateCategory(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateCategoryRequestSchema)) body: UpdateCategoryRequest,
  ) {
    return this.category.updateCategory(id, body);
  }

  @Delete('product/categories/:id')
  async deleteCategory(@Param('id') id: string) {
    await this.category.deleteCategory(id);
    return { deleted: true };
  }

  @Get('products/price-tiers')
  async priceTiers(
    @Query(new ZodValidationPipe(PageQueryParamsSchema)) query: PageQueryParams,
    @Query(new ZodValidationPipe(PriceTierListQuerySchema)) filter: PriceTierListQuery,
  ) {
    return this.priceTier.listPriceTiers(query, filter.skuId);
  }

  @Get('products/price-tiers/resolve')
  async resolvePrice(
    @Query(new ZodValidationPipe(ResolvePriceQuerySchema)) query: ResolvePriceQuery,
  ) {
    return this.priceTier.resolvePrice(query.skuId, query.quantity, query.channelCode ?? 'DIRECT');
  }

  @Post('products/price-tiers')
  createPriceTier(
    @Body(new ZodValidationPipe(CreatePriceTierRequestSchema)) body: CreatePriceTierRequest,
  ) {
    return this.priceTier.createPriceTier(body);
  }

  @Patch('products/price-tiers/:id')
  updatePriceTier(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdatePriceTierRequestSchema)) body: UpdatePriceTierRequest,
  ) {
    return this.priceTier.updatePriceTier(id, body);
  }

  @Delete('products/price-tiers/:id')
  async deletePriceTier(@Param('id') id: string) {
    await this.priceTier.deletePriceTier(id);
    return { deleted: true };
  }

  @Get('stock/warehouses')
  async warehouses(
    @Query(new ZodValidationPipe(PageQueryParamsSchema)) query: PageQueryParams,
  ) {
    return this.warehouse.listWarehouses(query);
  }

  @Post('stock/warehouses')
  createWarehouse(
    @Body(new ZodValidationPipe(CreateWarehouseRequestSchema)) body: CreateWarehouseRequest,
  ) {
    return this.warehouse.createWarehouse(body);
  }

  @Patch('stock/warehouses/:id')
  updateWarehouse(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateWarehouseRequestSchema)) body: UpdateWarehouseRequest,
  ) {
    return this.warehouse.updateWarehouse(id, body);
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
  async createOrder(
    @Body(new ZodValidationPipe(CreateOrderRequestSchema)) body: CreateOrderRequest,
  ) {
    const order = await this.sales.createOrder(body);
    await this.syncCustomerLevel(order.customerId);
    return order;
  }

  @Post('sales/orders/:id/pay')
  pay(@Param('id') id: string, @Body() body?: { useBalance?: boolean }) {
    return this.sales.payOrder(id, { useBalance: body?.useBalance === true });
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
  async cancel(@Param('id') id: string) {
    const order = await this.sales.cancelOrder(id);
    await this.syncCustomerLevel(order.customerId);
    return order;
  }

  /**
   * 订单新建/取消后按累计消费重评客户等级：派生数据，失败只记日志，
   * 绝不影响主单据的响应。
   */
  private async syncCustomerLevel(customerId?: string | null) {
    if (!customerId) return;
    try {
      await this.customer.reevaluateLevel(customerId);
    } catch (error) {
      console.warn(`[customer-level] reevaluate failed for ${customerId}:`, error);
    }
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

  /** 审批流配置（第 8 批）：v1 只有采购单门槛一条规则 */
  @Get('approval-rules')
  async approvalRules() {
    return this.approvalRule.listApprovalRules();
  }

  @Patch('approval-rules/:id')
  updateApprovalRule(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateApprovalRuleRequestSchema)) body: UpdateApprovalRuleRequest,
  ) {
    return this.approvalRule.updateApprovalRule(id, body);
  }

  /** 换货单（第 8 批）：退一个 SKU、换入另一个 SKU */
  @Get('sales/exchanges')
  async exchanges(
    @Query(new ZodValidationPipe(PageQueryParamsSchema)) query: PageQueryParams,
  ) {
    return this.exchange.listExchanges(query);
  }

  @Get('sales/exchanges/:id')
  async getExchange(@Param('id') id: string) {
    return this.exchange.findExchange(id);
  }

  @Post('sales/exchanges')
  createExchange(
    @Body(new ZodValidationPipe(CreateExchangeRequestSchema)) body: CreateExchangeRequest,
  ) {
    return this.exchange.createExchange(body);
  }

  @Post('sales/exchanges/:id/approve')
  approveExchange(@Param('id') id: string) {
    return this.exchange.approveExchange(id);
  }

  @Post('sales/exchanges/:id/reject')
  rejectExchange(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RejectExchangeRequestSchema)) body: RejectExchangeRequest,
  ) {
    return this.exchange.rejectExchange(id, body.reason);
  }

  @Post('sales/exchanges/:id/receive')
  receiveExchange(@Param('id') id: string) {
    return this.exchange.receiveExchange(id);
  }

  @Post('sales/exchanges/:id/exchange')
  completeExchange(@Param('id') id: string) {
    return this.exchange.completeExchange(id);
  }

  @Post('sales/exchanges/:id/cancel')
  cancelExchange(@Param('id') id: string) {
    return this.exchange.cancelExchange(id);
  }

  /**
   * CSV 导入（第 8 批）：multipart 文件上传（FileInterceptor，multer 是
   * @nestjs/platform-express 的自带依赖）。无文件 400；单行坏不影响整批，
   * 汇总在返回体里（created / skipped / errors）。
   */
  @Post('import/customers')
  @UseInterceptors(FileInterceptor('file'))
  async importCustomers(@UploadedFile() file?: { buffer: Buffer }) {
    if (!file) throw new DomainError('INVALID_STATE', '请上传 CSV 文件', 400);
    return this.importer.importCustomers(file.buffer);
  }

  @Post('import/stocktake')
  @UseInterceptors(FileInterceptor('file'))
  async importStocktakes(@UploadedFile() file?: { buffer: Buffer }) {
    if (!file) throw new DomainError('INVALID_STATE', '请上传 CSV 文件', 400);
    return this.importer.importStocktakes(file.buffer);
  }

  @Post('import/products')
  @UseInterceptors(FileInterceptor('file'))
  async importProducts(@UploadedFile() file?: { buffer: Buffer }) {
    if (!file) throw new DomainError('INVALID_STATE', '请上传 CSV 文件', 400);
    return this.importer.importProducts(file.buffer);
  }

  @Post('import/suppliers')
  @UseInterceptors(FileInterceptor('file'))
  async importSuppliers(@UploadedFile() file?: { buffer: Buffer }) {
    if (!file) throw new DomainError('INVALID_STATE', '请上传 CSV 文件', 400);
    return this.importer.importSuppliers(file.buffer);
  }

  @Get('shipments')
  async shipments(
    @Query(new ZodValidationPipe(PageQueryParamsSchema)) query: PageQueryParams,
  ) {
    return this.shipment.listShipments(query);
  }

  @Get('shipments/:id')
  async getShipment(@Param('id') id: string) {
    return this.shipment.findShipment(id);
  }

  @Post('shipments')
  createShipment(
    @Body(new ZodValidationPipe(CreateShipmentRequestSchema)) body: CreateShipmentRequest,
  ) {
    return this.shipment.createShipment(body);
  }

  @Post('shipments/:id/pick')
  pickShipment(@Param('id') id: string) {
    return this.shipment.pickShipment(id);
  }

  @Post('shipments/:id/pack')
  packShipment(@Param('id') id: string) {
    return this.shipment.packShipment(id);
  }

  @Post('shipments/:id/ship')
  shipShipment(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ShipShipmentRequestSchema)) body: ShipShipmentRequest,
  ) {
    return this.shipment.shipShipment(id, body);
  }

  @Post('shipments/:id/deliver')
  deliverShipment(@Param('id') id: string) {
    return this.shipment.deliverShipment(id);
  }

  @Post('shipments/:id/cancel')
  cancelShipment(@Param('id') id: string) {
    return this.shipment.cancelShipment(id);
  }

  @Get('invoices')
  async invoices(
    @Query(new ZodValidationPipe(PageQueryParamsSchema)) query: PageQueryParams,
  ) {
    return this.invoice.listInvoices(query);
  }

  @Get('invoices/:id')
  async getInvoice(@Param('id') id: string) {
    return this.invoice.findInvoice(id);
  }

  @Post('invoices')
  createInvoice(
    @Body(new ZodValidationPipe(CreateInvoiceRequestSchema)) body: CreateInvoiceRequest,
  ) {
    return this.invoice.createInvoice(body);
  }

  @Post('invoices/:id/issue')
  issueInvoice(@Param('id') id: string) {
    return this.invoice.issueInvoice(id);
  }

  @Post('invoices/:id/void')
  voidInvoice(@Param('id') id: string) {
    return this.invoice.voidInvoice(id);
  }

  @Post('invoices/:id/cancel')
  cancelInvoice(@Param('id') id: string) {
    return this.invoice.cancelInvoice(id);
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
