import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PrismaClient } from '@prisma/client';
import { IamService } from './application/iam.service';
import { CategoryService } from './application/category.service';
import { CustomerService } from './application/customer.service';
import { DashboardService } from './application/dashboard.service';
import { InvoiceService } from './application/invoice.service';
import { PriceTierService } from './application/price-tier.service';
import { ProductService } from './application/product.service';
import { PurchaseService } from './application/purchase.service';
import { RmaService } from './application/rma.service';
import { SalesService } from './application/sales.service';
import { ShipmentService } from './application/shipment.service';
import { StocktakeService } from './application/stocktake.service';
import { TransferService } from './application/transfer.service';
import { WarehouseService } from './application/warehouse.service';
import { DatabasePort, PaymentGatewayPort } from './domain/ports';
import { InMemoryDatabase } from './infrastructure/in-memory.database';
import { MockPaymentGateway } from './infrastructure/mock-payment.gateway';
import { PrismaDatabase } from './infrastructure/prisma.database';
import { ErpController } from './interface/http/erp.controller';
import { AuditInterceptor } from './interface/http/audit.interceptor';
import { AuthGuard } from './interface/http/auth.guard';

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
    ProductService,
    CategoryService,
    PriceTierService,
    WarehouseService,
    CustomerService,
    RmaService,
    ShipmentService,
    InvoiceService,
    TransferService,
    StocktakeService,
    DashboardService,
    AuditInterceptor,
    AuthGuard,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: DatabasePort, useFactory: createDatabase },
    { provide: PaymentGatewayPort, useClass: MockPaymentGateway },
  ],
})
export class AppModule {}
