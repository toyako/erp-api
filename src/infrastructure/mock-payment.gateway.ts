import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PaymentGatewayPort } from '../domain/ports';

/** 演示适配器：不触达任何真实支付通道 */
@Injectable()
export class MockPaymentGateway extends PaymentGatewayPort {
  async charge(input: { orderId: string; amount: number; currency: string }) {
    void input;
    return { reference: `mock-${randomUUID()}` };
  }
}
