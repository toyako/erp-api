import { randomUUID } from 'node:crypto';
import { describe, expect, it, beforeEach } from 'vitest';
import { ApprovalRuleService } from '../src/application/approval-rule.service';
import { PurchaseService } from '../src/application/purchase.service';
import { InMemoryDatabase } from '../src/infrastructure/in-memory.database';

/** InMemory 种子价 SKU-001 ¥199；审批规则种子：采购单 ≥ ¥10,000 需管理员审批 */
describe('第 8 批：审批流配置（采购单门槛）', () => {
  let db: InMemoryDatabase;
  let purchase: PurchaseService;
  let rules: ApprovalRuleService;

  beforeEach(() => {
    db = new InMemoryDatabase();
    purchase = new PurchaseService(db);
    rules = new ApprovalRuleService(db);
  });

  async function makeSupplier() {
    const supplier = {
      id: randomUUID(),
      tenantId: '00000000-0000-4000-8000-000000000001',
      code: `SUP-${randomUUID().slice(0, 8)}`,
      name: '测试供货商',
      rating: 4 as const,
      enabled: true,
    };
    await db.saveSupplier(supplier);
    return supplier;
  }

  async function submittedOrder(quantity: number) {
    const supplier = await makeSupplier();
    const sku = (await db.listSkus({ page: 1, pageSize: 20 })).items[0];
    const order = await purchase.createPurchaseOrder({ supplierId: supplier.id, lines: [{ skuId: sku.id, quantity }] });
    await purchase.submitPurchaseOrder(order.id);
    return order;
  }

  it('种子规则：采购单 ≥ ¥10,000、approverRole admin、已启用', async () => {
    const list = await rules.listApprovalRules();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ docType: 'purchase_order', thresholdAmount: { amount: 1000000, currency: 'CNY' }, approverRole: 'admin', enabled: true });
  });

  it('门槛以下：sales 审核通过（不走审批流）', async () => {
    const order = await submittedOrder(5); // 5 × ¥199 = ¥995
    const approved = await purchase.approvePurchaseOrder(order.id, ['sales']);
    expect(approved.status).toBe('approved');
  });

  it('门槛以上：sales 审核 403、admin 审核通过', async () => {
    const order = await submittedOrder(60); // 60 × ¥199 = ¥11,940
    await expect(purchase.approvePurchaseOrder(order.id, ['sales'])).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(purchase.approvePurchaseOrder(order.id, ['sales'])).rejects.toThrow(/需管理员审批/);
    const approved = await purchase.approvePurchaseOrder(order.id, ['admin']);
    expect(approved.status).toBe('approved');
  });

  it('规则停用后：sales 也能审大单；改门槛即时生效', async () => {
    const list = await rules.listApprovalRules();
    await rules.updateApprovalRule(list[0].id, { enabled: false });
    const order = await submittedOrder(60);
    const approved = await purchase.approvePurchaseOrder(order.id, ['sales']);
    expect(approved.status).toBe('approved');
    await rules.updateApprovalRule(list[0].id, { enabled: true, thresholdAmount: { amount: 2000000, currency: 'CNY' } });
    const order2 = await submittedOrder(60); // ¥11,940 < 新门槛 ¥20,000
    const approved2 = await purchase.approvePurchaseOrder(order2.id, ['sales']);
    expect(approved2.status).toBe('approved');
  });

  it('改不存在的规则 404', async () => {
    await expect(rules.updateApprovalRule(randomUUID(), { enabled: false })).rejects.toMatchObject({ status: 404 });
  });
});
