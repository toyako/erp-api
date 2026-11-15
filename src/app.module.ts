import { Module } from '@nestjs/common';
import { IamService } from './application/iam.service';
import { SalesService } from './application/sales.service';
import { DatabasePort, PaymentGatewayPort } from './domain/ports';
import { InMemoryDatabase } from './infrastructure/in-memory.database';
import { MockPaymentGateway } from './infrastructure/mock-payment.gateway';
import { ErpController } from './interface/http/erp.controller';

@Module({
  controllers: [ErpController],
  providers: [
    IamService,
    SalesService,
    { provide: DatabasePort, useClass: InMemoryDatabase },
    { provide: PaymentGatewayPort, useClass: MockPaymentGateway },
  ],
})
export class AppModule {}
