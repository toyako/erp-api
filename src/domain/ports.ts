import type {
  InventoryLot,
  PageQueryParams,
  PriceList,
  Principal,
  PurchaseOrder,
  SalesOrder,
  Sku,
  Supplier,
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
  abstract listPrincipals(params: PageQueryParams): Promise<Page<Principal>>;
  abstract listSkus(params: PageQueryParams): Promise<Page<Sku>>;
  abstract findSku(id: string): Promise<Sku | null>;
  abstract saveSku(sku: Sku): Promise<void>;
  abstract findPriceBySku(skuId: string): Promise<PriceList | null>;
  abstract listLots(params: PageQueryParams): Promise<Page<InventoryLot>>;
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
