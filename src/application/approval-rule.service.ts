import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ApprovalRule, CreateApprovalRuleRequest, UpdateApprovalRuleRequest } from '@erp/contracts';
import { DatabasePort, DomainError } from '../domain/ports';
import { TENANT_ID } from './sales.service';

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

  /** 新建规则：v1 每种单据只有一条，同 docType 已有规则时报 409 */
  async createApprovalRule(input: CreateApprovalRuleRequest): Promise<ApprovalRule> {
    const existing = await this.db.listApprovalRules();
    if (existing.some((r) => r.docType === input.docType)) {
      throw new DomainError('CONFLICT', `审批规则 ${input.docType} 已存在`, 409);
    }
    const now = new Date().toISOString();
    const rule: ApprovalRule = {
      id: randomUUID(),
      tenantId: TENANT_ID,
      docType: input.docType,
      thresholdAmount: input.thresholdAmount,
      approverRole: 'admin',
      enabled: input.enabled,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.saveApprovalRule(rule);
    return rule;
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
