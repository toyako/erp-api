import type {
  InventoryLot,
  PriceList,
  Principal,
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

export abstract class DatabasePort {
  abstract findPrincipalByUsername(username: string): Promise<Principal | null>;
  /** 仅供认证校验，不通过契约对外暴露 */
  abstract findPasswordHash(username: string): Promise<string | null>;
  abstract listPrincipals(): Promise<Principal[]>;
  abstract listSkus(): Promise<Sku[]>;
  abstract findSku(id: string): Promise<Sku | null>;
  abstract findPriceBySku(skuId: string): Promise<PriceList | null>;
  abstract listLots(): Promise<InventoryLot[]>;
  abstract findLotBySku(skuId: string): Promise<InventoryLot | null>;
  abstract saveLot(lot: InventoryLot): Promise<void>;
  abstract saveOrder(order: SalesOrder): Promise<void>;
  abstract listOrders(): Promise<SalesOrder[]>;
  abstract findOrder(id: string): Promise<SalesOrder | null>;
  abstract listSuppliers(): Promise<Supplier[]>;
  abstract saveSupplier(supplier: Supplier): Promise<void>;
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
