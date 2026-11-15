# @erp/api

> **erp-platform 四仓库之一**：[erp-contracts](https://github.com/toyako/erp-contracts) · [erp-api](https://github.com/toyako/erp-api) · [erp-admin](https://github.com/toyako/erp-admin) · [erp-desktop](https://github.com/toyako/erp-desktop)
>
> 本地开发需四仓库并列存放；`erp-api` 与 `erp-admin` 通过 `file:../erp-contracts` 引用契约。

纯净 ERP 后端，严格按 `架构总纲.md` 第 4 节四层单向依赖组织。

## 分层

| 目录 | 职责 | 允许依赖 |
|---|---|---|
| `src/domain/` | 端口接口、领域异常、订单状态机 | 仅 `@erp/contracts` 类型 |
| `src/application/` | 用例编排、事务边界、服务端定价 | domain + contracts |
| `src/infrastructure/` | 适配器实现（InMemory / Mock） | domain 的端口接口 |
| `src/interface/http/` | Controller、Zod 校验管道、异常过滤器 | application |

🔴 领域层不出现 `@nestjs/*`、ORM 或 SDK 引用；外部能力一律端口 + 适配器（ADR-0005）。

## 运行

```bash
pnpm --filter @erp/contracts build
pnpm --filter @erp/api build
pnpm --filter @erp/api start
```

默认 `http://127.0.0.1:3000/api`，`DESKTOP_MODE=demo` 时走 `InMemoryDatabase` + `MockPaymentGateway`，**无需数据库、无需外网**。

演示账号：`admin` / `sales` / `viewer`，口令统一 `demo1234`。

## 核心链路

`POST /api/auth/login` → `GET /api/products/skus` → `POST /api/sales/orders`（服务端定价 + 库存占用）→ `POST /api/sales/orders/:id/pay` → `POST /api/sales/orders/:id/fulfill`

- 金额由服务端按 `PriceList` 计算，请求体**不含金额**
- 库存占用与订单创建在同一事务边界（`runInTransaction`），失败回滚
- 状态迁移由 `ORDER_TRANSITIONS` 约束，非法迁移返回 `INVALID_STATE`

## 数据模型

`prisma/schema.prisma`（ADR-0007）与 `prisma/seed.ts` 已定义，P2 接入 Prisma 适配器时执行 `prisma generate` / `migrate`。**任何环境禁用 `db push` / `synchronize`**。

## 冒烟

```bash
node scripts/smoke-api.cjs
```
