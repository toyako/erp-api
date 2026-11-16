import { Injectable } from '@nestjs/common';
import type { ApprovalRule, UpdateApprovalRuleRequest } from '@erp/contracts';
import { DatabasePort, DomainError } from '../domain/ports';

/**
 * 审批流配置（第 8 批）：v1 只有采购单门槛一条规则。
 * 规则本身只存数据，生效点在 PurchaseService.approvePurchaseOrder。
 */
@Injectable()
export class ApprovalRuleService {
  constructor(private readonly db: DatabasePort) {}

  listApprovalRules() {
    return this.db.listApprovalRules();
  }

  async updateApprovalRule(id: string, input: UpdateApprovalRuleRequest): Promise<ApprovalRule> {
    const rule = await this.db.findApprovalRule(id);
    if (!rule) throw new DomainError('NOT_FOUND', `审批规则 ${id} 不存在`, 404);
    if (input.thresholdAmount !== undefined) rule.thresholdAmount = input.thresholdAmount;
    if (input.enabled !== undefined) rule.enabled = input.enabled;
    rule.updatedAt = new Date().toISOString();
    await this.db.saveApprovalRule(rule);
    return rule;
  }
}
