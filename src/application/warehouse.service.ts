import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  CreateWarehouseRequest,
  PageQueryParams,
  UpdateWarehouseRequest,
  Warehouse,
} from '@erp/contracts';
import { DatabasePort, DomainError } from '../domain/ports';
import { TENANT_ID } from './sales.service';

@Injectable()
export class WarehouseService {
  constructor(private readonly db: DatabasePort) {}

  listWarehouses(params: PageQueryParams) {
    return this.db.listWarehouses(params);
  }

  async createWarehouse(input: CreateWarehouseRequest): Promise<Warehouse> {
    const dup = await this.db.findWarehouseByCode(input.code);
    if (dup) throw new DomainError('CONFLICT', `仓库编码 ${input.code} 已存在`, 409);
    const warehouse: Warehouse = {
      id: randomUUID(),
      tenantId: TENANT_ID,
      code: input.code,
      name: input.name,
      ...(input.address ? { address: input.address } : {}),
      enabled: true,
    };
    await this.db.saveWarehouse(warehouse);
    return warehouse;
  }

  async updateWarehouse(id: string, input: UpdateWarehouseRequest): Promise<Warehouse> {
    const warehouse = await this.requireWarehouse(id);
    if (input.enabled === false && warehouse.enabled) {
      // 停用校验：有批次引用该仓库 code 时不允许停用
      const lots = await this.db.listLots({ page: 1, pageSize: 1000 });
      if (lots.items.some((l) => l.location === warehouse.code)) {
        throw new DomainError('CONFLICT', `仓库 ${warehouse.code} 下还有库存批次，不能停用`, 409);
      }
    }
    if (input.name !== undefined) warehouse.name = input.name;
    if (input.address !== undefined) warehouse.address = input.address;
    if (input.enabled !== undefined) warehouse.enabled = input.enabled;
    await this.db.saveWarehouse(warehouse);
    return warehouse;
  }

  private async requireWarehouse(id: string): Promise<Warehouse> {
    const warehouse = await this.db.findWarehouse(id);
    if (!warehouse) throw new DomainError('NOT_FOUND', `仓库 ${id} 不存在`, 404);
    return warehouse;
  }
}
