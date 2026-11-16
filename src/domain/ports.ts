import type {
  AuditEvent,
  AuditEventListQuery,
  Customer,
  InventoryLot,
  PageQueryParams,
  PriceList,
  Principal,
  PurchaseOrder,
  Rma,
  SalesOrder,
  Shipment,
  Sku,
  Spu,
  Stocktake,
  Supplier,
  Transfer,
} from '@erp/contracts';

export type DomainErrorCode =
  | 'NOT_FOUND'
  | 'INSUFFICIENT_STOCK'
  | 'INVALID_STATE'
  | 'UNAUTHORIZED'
  | 'CONFLICT'
  | 'FORBIDDEN';

/** 纯领域异常，不依赖任何 Web 框架；由 interface 层统一转换为 HTTP 响应 */
export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

/** 分页结果：与 HTTP 响应形状一致 { items, total, page, pageSize } */
export type Page<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};

export abstract class DatabasePort {
  abstract findPrincipalByUsername(username: string): Promise<Principal | null>;
  /** 仅供认证校验，不通过契约对外暴露 */
  abstract findPasswordHash(username: string): Promise<string | null>;
  abstract findPrincipal(id: string): Promise<Principal | null>;
  /** 新建/改用户时一并写口令 hash；改用户不改密码时调用方传现存 hash */
  abstract savePrincipal(principal: Principal, passwordHash: string): Promise<void>;
  abstract listPrincipals(params: PageQueryParams): Promise<Page<Principal>>;
  abstract listSpus(params: PageQueryParams): Promise<Page<Spu>>;
  abstract findSpu(id: string): Promise<Spu | null>;
  abstract listSkus(params: PageQueryParams): Promise<Page<Sku>>;
  abstract findSku(id: string): Promise<Sku | null>;
  abstract saveSku(sku: Sku): Promise<void>;
  abstract findPriceBySku(skuId: string): Promise<PriceList | null>;
  abstract listPrices(params: PageQueryParams): Promise<Page<PriceList>>;
  abstract findPrice(id: string): Promise<PriceList | null>;
  abstract savePrice(price: PriceList): Promise<void>;
  abstract listLots(params: PageQueryParams): Promise<Page<InventoryLot>>;
  abstract findLot(id: string): Promise<InventoryLot | null>;
  abstract findLotBySku(skuId: string): Promise<InventoryLot | null>;
  abstract saveLot(lot: InventoryLot): Promise<void>;
  abstract saveOrder(order: SalesOrder): Promise<void>;
  abstract listOrders(params: PageQueryParams): Promise<Page<SalesOrder>>;
  abstract findOrder(id: string): Promise<SalesOrder | null>;
  abstract listSuppliers(params: PageQueryParams): Promise<Page<Supplier>>;
  abstract findSupplier(id: string): Promise<Supplier | null>;
  abstract saveSupplier(supplier: Supplier): Promise<void>;
  abstract listPurchaseOrders(params: PageQueryParams): Promise<Page<PurchaseOrder>>;
  abstract findPurchaseOrder(id: string): Promise<PurchaseOrder | null>;
  abstract savePurchaseOrder(order: PurchaseOrder): Promise<void>;
  abstract listCustomers(params: PageQueryParams): Promise<Page<Customer>>;
  abstract findCustomer(id: string): Promise<Customer | null>;
  abstract saveCustomer(customer: Customer): Promise<void>;
  abstract listRmas(params: PageQueryParams): Promise<Page<Rma>>;
  abstract findRma(id: string): Promise<Rma | null>;
  abstract saveRma(rma: Rma): Promise<void>;
  abstract listShipments(params: PageQueryParams): Promise<Page<Shipment>>;
  abstract findShipment(id: string): Promise<Shipment | null>;
  abstract saveShipment(shipment: Shipment): Promise<void>;
  abstract listTransfers(params: PageQueryParams): Promise<Page<Transfer>>;
  abstract findTransfer(id: string): Promise<Transfer | null>;
  abstract saveTransfer(transfer: Transfer): Promise<void>;
  abstract listStocktakes(params: PageQueryParams): Promise<Page<Stocktake>>;
  abstract findStocktake(id: string): Promise<Stocktake | null>;
  abstract saveStocktake(stocktake: Stocktake): Promise<void>;
  /** 审计日志：拦截器横切写入；列表按 createdAt 倒序，entity 精确过滤、action 子串过滤 */
  abstract listAuditEvents(params: AuditEventListQuery): Promise<Page<AuditEvent>>;
  abstract findAuditEvent(id: string): Promise<AuditEvent | null>;
  abstract saveAuditEvent(event: AuditEvent): Promise<void>;
  /** 订单确认与库存占用必须在同一事务边界；回调收到事务内的仓储句柄 */
  abstract runInTransaction<T>(fn: (tx: DatabasePort) => Promise<T>): Promise<T>;
}

export abstract class PaymentGatewayPort {
  abstract charge(input: {
    orderId: string;
    amount: number;
    currency: string;
  }): Promise<{ reference: string }>;
}
