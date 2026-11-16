import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  Category,
  CategoryTreeNode,
  CreateCategoryRequest,
  PageQueryParams,
  UpdateCategoryRequest,
} from '@erp/contracts';
import { DatabasePort, DomainError } from '../domain/ports';
import { TENANT_ID } from './sales.service';

@Injectable()
export class CategoryService {
  constructor(private readonly db: DatabasePort) {}

  listCategories(params: PageQueryParams) {
    return this.db.listCategories(params);
  }

  listTree(): Promise<CategoryTreeNode[]> {
    return this.db.listCategoryTree();
  }

  async createCategory(input: CreateCategoryRequest): Promise<Category> {
    const dup = await this.db.findCategoryByCode(input.code);
    if (dup) throw new DomainError('CONFLICT', `分类编码 ${input.code} 已存在`, 409);
    if (input.parentId) {
      const parent = await this.db.findCategory(input.parentId);
      if (!parent) throw new DomainError('NOT_FOUND', `父分类 ${input.parentId} 不存在`, 404);
    }
    const category: Category = {
      id: randomUUID(),
      tenantId: TENANT_ID,
      code: input.code,
      name: input.name,
      parentId: input.parentId ?? null,
      sort: input.sort ?? 0,
      enabled: true,
    };
    await this.db.saveCategory(category);
    return category;
  }

  async updateCategory(id: string, input: UpdateCategoryRequest): Promise<Category> {
    const category = await this.requireCategory(id);
    if (input.parentId !== undefined) {
      if (input.parentId === id) {
        throw new DomainError('INVALID_STATE', '分类不能挂到自己下面', 400);
      }
      if (input.parentId) {
        const parent = await this.db.findCategory(input.parentId);
        if (!parent) throw new DomainError('NOT_FOUND', `父分类 ${input.parentId} 不存在`, 404);
        // 成环校验：从新父级沿父链上溯，走到自己即成环
        let cursor: Category | null = parent;
        while (cursor) {
          if (cursor.id === id) {
            throw new DomainError('INVALID_STATE', '不能把分类挂到自己的子孙下面', 400);
          }
          cursor = cursor.parentId ? await this.db.findCategory(cursor.parentId) : null;
        }
      }
      category.parentId = input.parentId;
    }
    if (input.name !== undefined) category.name = input.name;
    if (input.sort !== undefined) category.sort = input.sort;
    if (input.enabled !== undefined) category.enabled = input.enabled;
    await this.db.saveCategory(category);
    return category;
  }

  async deleteCategory(id: string): Promise<void> {
    const category = await this.requireCategory(id);
    const all = await this.db.listCategories({ page: 1, pageSize: 1000 });
    if (all.items.some((c) => c.parentId === id)) {
      throw new DomainError('CONFLICT', `分类 ${category.code} 下还有子分类，不能删除`, 409);
    }
    const spus = await this.db.listSpus({ page: 1, pageSize: 1000 });
    if (spus.items.some((s) => s.categoryCode === category.code)) {
      throw new DomainError('CONFLICT', `分类 ${category.code} 下还有商品，不能删除`, 409);
    }
    await this.db.deleteCategory(id);
  }

  private async requireCategory(id: string): Promise<Category> {
    const category = await this.db.findCategory(id);
    if (!category) throw new DomainError('NOT_FOUND', `分类 ${id} 不存在`, 404);
    return category;
  }
}
