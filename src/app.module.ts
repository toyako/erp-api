import { Module } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { IamService } from './application/iam.service';
import { DashboardService } from './application/dashboard.service';
import { PurchaseService } from './application/purchase.service';
import { SalesService } from './application/sales.service';
import { DatabasePort, PaymentGatewayPort } from './domain/ports';
import { InMemoryDatabase } from './infrastructure/in-memory.database';
import { MockPaymentGateway } from './infrastructure/mock-payment.gateway';
import { PrismaDatabase } from './infrastructure/prisma.database';
import { ErpController } from './interface/http/erp.controller';

/** ERP_DB_ADAPTER=prisma 时连真实数据库，否则用内存演示适配器 */
function createDatabase(): DatabasePort {
  if (process.env.ERP_DB_ADAPTER === 'prisma') {
    return new PrismaDatabase(new PrismaClient());
  }
  return new InMemoryDatabase();
}

@Module({
  controllers: [ErpController],
  providers: [
    IamService,
    SalesService,
    PurchaseService,
    DashboardService,
    { provide: DatabasePort, useFactory: createDatabase },
    { provide: PaymentGatewayPort, useClass: MockPaymentGateway },
  ],
})
export class AppModule {}
