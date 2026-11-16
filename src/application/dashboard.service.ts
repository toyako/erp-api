import { Injectable } from '@nestjs/common';
import type {
  FinanceSummary,
  MovementListQuery,
  MovementRow,
  OverviewSummary,
  PageQueryParams,
  RecentActivity,
  ReceivableRow,
  ReportRange,
  ReportSummary,
  SalesOrder,
  TodoItem,
  TodoListQuery,
} from '@erp/contracts';
import { DatabasePort, type Page } from '../domain/ports';

/**
 * 仪表盘汇总服务：聚合页不再从列表接口拉全量后在前端聚合。
 * 聚合方法：用 Port 已有的分页 list 方法以 pageSize 200 循环拉取，直到
 * collected >= total 再聚合——永远不只取第 1 页；聚合在内存里做。
 * SQL 层 groupBy 是后续步骤，分页拉取保证双适配器行为一致。
 * 日期一律按服务端 UTC 日计算（与前端本地时区口径不同，见 manifest）。
 */

const DAY_MS = 86400000;
const WARNING_QTY = 20;

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD'（UTC）加减天数 */
function addDays(date: string, days: number): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return new Date(Date.UTC(y, m - 1, d) + days * DAY_MS).toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' 当天 00:00 UTC 的毫秒时间戳 */
function dayStartMs(date: string): number {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return Date.UTC(y, m - 1, d);
}

function monthDayLabel(date: string): string {
  const [, m, d] = date.split('-').map(Number);
  return `${m}-${String(d).padStart(2, '0')}`;
}

function paginate<T>(items: T[], params: PageQueryParams): Page<T> {
  const start = (params.page - 1) * params.pageSize;
  return {
    items: items.slice(start, start + params.pageSize),
    total: items.length,
    page: params.page,
    pageSize: params.pageSize,
  };
}

@Injectable()
export class DashboardService {
  constructor(private readonly db: DatabasePort) {}

  /** 分页循环拉全量：直到 collected >= total 或某页为空才停 */
  private async collectAll<T>(
    list: (params: PageQueryParams) => Promise<Page<T>>,
  ): Promise<T[]> {
    const all: T[] = [];
    let page = 1;
    for (;;) {
      const result = await list({ page, pageSize: 200 });
      all.push(...result.items);
      if (all.length >= result.total || result.items.length === 0) break;
      page += 1;
    }
    return all;
  }

  private async loadAll() {
    const [orders, lots, skus, purchaseOrders] = await Promise.all([
      this.collectAll((p) => this.db.listOrders(p)),
      this.collectAll((p) => this.db.listLots(p)),
      this.collectAll((p) => this.db.listSkus(p)),
      this.collectAll((p) => this.db.listPurchaseOrders(p)),
    ]);
    return { orders, lots, skus, purchaseOrders };
  }

  async getOverview(): Promise<OverviewSummary> {
    const { orders, lots, skus } = await this.loadAll();
    const skuById = new Map(skus.map((s) => [s.id, s]));

    const statusMap = new Map<string, number>();
    let salesAmount = 0;
    let fulfilledCount = 0;
    for (const o of orders) {
      statusMap.set(o.status, (statusMap.get(o.status) ?? 0) + 1);
      if (o.status === 'fulfilled') fulfilledCount += 1;
      // 已取消的单不是销售额：与 getReport 口径一致（报表侧一直排除 cancelled）
      if (o.status === 'cancelled') continue;
      salesAmount += o.total.amount;
    }

    const today = todayUtc();
    const trend7 = Array.from({ length: 7 }, (_, i) => {
      const date = addDays(today, i - 6);
      const amount = orders
        .filter((o) => o.status !== 'cancelled' && o.createdAt.slice(0, 10) === date)
        .reduce((n, o) => n + o.total.amount, 0);
      return { date, amount };
    });

    const qtyBySku = new Map<string, number>();
    for (const o of orders) {
      if (o.status === 'cancelled') continue;
      for (const line of o.lines) {
        qtyBySku.set(line.skuId, (qtyBySku.get(line.skuId) ?? 0) + line.quantity);
      }
    }
    const ranking = [...qtyBySku.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([skuId, qty]) => {
        const sku = skuById.get(skuId);
        return { skuId, code: sku ? sku.code : skuId.slice(0, 8), spec: sku ? sku.spec : '', qty };
      });

    const lowStock = [...lots]
      .sort((a, b) => a.availableQty - b.availableQty)
      .slice(0, 4)
      .map((lot) => ({
        batchCode: lot.batchCode,
        skuCode: skuById.get(lot.skuId)?.code ?? '—',
        availableQty: lot.availableQty,
        reservedQty: lot.reservedQty,
        totalQty: lot.totalQty,
      }));

    const firstSku = [...skus].sort((a, b) => a.code.localeCompare(b.code))[0];
    return {
      salesAmount,
      orderCount: orders.length,
      fulfilledCount,
      availableStock: lots.reduce((n, l) => n + l.availableQty, 0),
      reservedStock: lots.reduce((n, l) => n + l.reservedQty, 0),
      warningCount: lots.filter((l) => l.availableQty < WARNING_QTY).length,
      statusDist: [...statusMap.entries()].map(([status, count]) => ({ status: status as SalesOrder['status'], count })),
      trend7,
      ranking,
      lowStock,
      firstSku: firstSku ? { id: firstSku.id, code: firstSku.code } : null,
    };
  }

  async getReport(range: ReportRange): Promise<ReportSummary> {
    const { orders, lots, skus } = await this.loadAll();
    const skuById = new Map(skus.map((s) => [s.id, s]));

    // month 取本月已过天数（今日是几号），与原前端 rangeDays 口径一致
    const today = todayUtc();
    const days = range === '30d' ? 30 : range === 'month' ? Number(today.slice(8, 10)) : 7;
    const startMs = dayStartMs(addDays(today, -(days - 1)));
    const endMs = dayStartMs(today) + DAY_MS - 1;
    const prevEndMs = startMs - 1;
    const prevStartMs = startMs - days * DAY_MS;
    const inRange = (iso: string, s: number, e: number) => {
      const t = new Date(iso).getTime();
      return t >= s && t <= e;
    };
    const curOrders = orders.filter((o) => o.status !== 'cancelled' && inRange(o.createdAt, startMs, endMs));
    const prevOrders = orders.filter((o) => o.status !== 'cancelled' && inRange(o.createdAt, prevStartMs, prevEndMs));

    const size = Math.ceil(days / 6);
    const buckets = Array.from({ length: 6 }, (_, i) => ({
      label: monthDayLabel(addDays(today, -(days - 1) + i * size)),
      amount: 0,
    }));
    for (const o of curOrders) {
      const idx = Math.min(5, Math.floor((new Date(o.createdAt).getTime() - startMs) / (DAY_MS * size)));
      const bucket = buckets[idx];
      if (bucket) bucket.amount += o.total.amount;
    }

    const cur = new Map<string, { qty: number; amount: number }>();
    const prev = new Map<string, number>();
    for (const o of curOrders) {
      for (const line of o.lines) {
        const e = cur.get(line.skuId) ?? { qty: 0, amount: 0 };
        e.qty += line.quantity;
        e.amount += line.unitPrice.amount * line.quantity;
        cur.set(line.skuId, e);
      }
    }
    for (const o of prevOrders) {
      for (const line of o.lines) prev.set(line.skuId, (prev.get(line.skuId) ?? 0) + line.quantity);
    }
    const ranking = [...cur.entries()]
      .sort((a, b) => b[1].amount - a[1].amount)
      .map(([skuId, v]) => {
        const sku = skuById.get(skuId);
        const p = prev.get(skuId) ?? 0;
        return {
          skuId,
          code: sku ? sku.code : skuId.slice(0, 8),
          spec: sku ? sku.spec : '',
          qty: v.qty,
          amount: v.amount,
          change: p === 0 ? null : Math.round(((v.qty - p) / p) * 1000) / 10,
        };
      });

    const sold = new Map<string, number>();
    for (const o of curOrders) {
      for (const line of o.lines) sold.set(line.skuId, (sold.get(line.skuId) ?? 0) + line.quantity);
    }
    const turnover = skus
      .map((sku) => {
        const stock = lots
          .filter((l) => l.skuId === sku.id)
          .reduce((n, l) => n + l.availableQty + l.reservedQty, 0);
        const qty = sold.get(sku.id) ?? 0;
        const daily = qty / days;
        return {
          name: `${sku.code} · ${sku.spec}`,
          stock,
          days: daily > 0 ? Math.round((stock / daily) * 10) / 10 : null,
        };
      })
      .map((r, _, rows) => {
        const max = Math.max(...rows.map((x) => x.days ?? 0), 1);
        return { ...r, pct: r.days === null ? 0 : Math.round((r.days / max) * 100) };
      })
      .sort((a, b) => (a.days ?? 9999) - (b.days ?? 9999));

    const soldSet = new Set(sold.keys());
    const slow = skus
      .filter((s) => !soldSet.has(s.id))
      .map((s) => ({
        name: `${s.code} · ${s.spec}`,
        stock: lots.filter((l) => l.skuId === s.id).reduce((n, l) => n + l.availableQty, 0),
      }));

    return { range, buckets, ranking, turnover, slow };
  }

  /** 待办派生：订单按状态一条、可用量 < 20 的批次一条预警；先过滤再分页 */
  async listTodos(query: TodoListQuery): Promise<Page<TodoItem>> {
    const { orders, lots } = await this.loadAll();
    const items: TodoItem[] = [];
    for (const o of orders) {
      if (o.status === 'paid') {
        items.push({ id: `ship-${o.id}`, type: 'order', typeLabel: '订单', cls: 'blue', title: '销售订单待发货', refNo: o.orderNo, actor: '系统', time: o.createdAt, done: false, action: '去发货', to: '/erp/sales/orders' });
      } else if (o.status === 'confirmed') {
        items.push({ id: `pay-${o.id}`, type: 'order', typeLabel: '订单', cls: 'orange', title: '销售订单待收款', refNo: o.orderNo, actor: '系统', time: o.createdAt, done: false, action: '去收款', to: '/erp/sales/orders' });
      } else if (o.status === 'draft') {
        items.push({ id: `confirm-${o.id}`, type: 'order', typeLabel: '订单', cls: 'orange', title: '销售订单待确认', refNo: o.orderNo, actor: '系统', time: o.createdAt, done: false, action: '去确认', to: '/erp/sales/orders' });
      } else if (o.status === 'fulfilled') {
        // 已完成 / 已取消沿用原前端口径：type 为 notice（过滤器“通知”下可见）
        items.push({ id: `done-${o.id}`, type: 'notice', typeLabel: '通知', cls: 'green', title: '销售订单已完成', refNo: o.orderNo, actor: '系统', time: o.createdAt, done: true, action: '查看', to: '/erp/sales/orders' });
      } else if (o.status === 'cancelled') {
        items.push({ id: `cancel-${o.id}`, type: 'notice', typeLabel: '通知', cls: 'gray', title: '销售订单已取消', refNo: o.orderNo, actor: '系统', time: o.createdAt, done: true, action: '查看', to: '/erp/sales/orders' });
      }
    }
    for (const lot of lots) {
      if (lot.availableQty < WARNING_QTY) {
        items.push({ id: `warn-${lot.id}`, type: 'warning', typeLabel: '预警', cls: 'red', title: `${lot.batchCode} 库存低于安全线`, refNo: lot.batchCode, actor: '系统', time: '', done: false, action: '查看批次', to: '/erp/stock/lots' });
      }
    }
    items.sort((a, b) => Number(a.done) - Number(b.done) || b.time.localeCompare(a.time));
    const kw = query.keyword?.trim().toLowerCase() ?? '';
    const filtered = items.filter((i) => {
      if (query.type && i.type !== query.type) return false;
      if (query.status === 'pending' && i.done) return false;
      if (query.status === 'done' && !i.done) return false;
      if (kw && !`${i.title} ${i.refNo}`.toLowerCase().includes(kw)) return false;
      return true;
    });
    return paginate(filtered, query);
  }

  async getFinanceSummary(): Promise<FinanceSummary> {
    const { orders, purchaseOrders } = await this.loadAll();
    const ym = todayUtc().slice(0, 7);
    return {
      receivable: orders
        .filter((o) => o.status === 'confirmed')
        .reduce((n, o) => n + o.total.amount, 0),
      payable: purchaseOrders
        .filter((o) => o.status === 'draft' || o.status === 'submitted')
        .reduce((n, o) => n + o.total.amount, 0),
      receivedThisMonth: orders
        .filter((o) => (o.status === 'paid' || o.status === 'fulfilled') && o.createdAt.slice(0, 7) === ym)
        .reduce((n, o) => n + o.total.amount, 0),
      paidThisMonth: purchaseOrders
        .filter((o) => o.status === 'received' && o.createdAt.slice(0, 7) === ym)
        .reduce((n, o) => n + o.total.amount, 0),
    };
  }

  async listReceivables(params: PageQueryParams): Promise<Page<ReceivableRow>> {
    const { orders } = await this.loadAll();
    const rows = orders
      .filter((o) => o.status === 'confirmed' || o.status === 'paid' || o.status === 'fulfilled')
      .map((o) => ({
        id: o.id,
        orderNo: o.orderNo,
        status: o.status,
        amount: o.total.amount,
        currency: o.total.currency,
        settled: o.status === 'confirmed' ? 0 : o.total.amount,
        unsettled: o.status === 'confirmed' ? o.total.amount : 0,
        createdAt: o.createdAt,
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return paginate(rows, params);
  }

  async getRecentActivity(): Promise<RecentActivity> {
    const { orders } = await this.loadAll();
    return [...orders]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 5)
      .map((o) => ({
        text: `创建销售订单 ${o.orderNo}`,
        meta: `系统 · ${o.createdAt.slice(0, 10)}`,
        time: o.createdAt,
      }));
  }

  /** 库存流水派生：fulfilled 为销售出库，draft/confirmed/paid 为库存占用，cancelled 跳过 */
  async listMovements(query: MovementListQuery): Promise<Page<MovementRow>> {
    const { orders, lots, skus } = await this.loadAll();
    const skuById = new Map(skus.map((s) => [s.id, s]));
    const firstBatchBySku = new Map<string, string>();
    for (const lot of [...lots].sort((a, b) => a.batchCode.localeCompare(b.batchCode))) {
      if (!firstBatchBySku.has(lot.skuId)) firstBatchBySku.set(lot.skuId, lot.batchCode);
    }
    const rows: MovementRow[] = [];
    for (const o of orders) {
      for (const line of o.lines) {
        const batch = firstBatchBySku.get(line.skuId) ?? '—';
        const sku = skuById.get(line.skuId);
        const skuName = sku ? `${sku.code} · ${sku.spec}` : line.skuId.slice(0, 8);
        if (o.status === 'fulfilled') {
          rows.push({ id: `out-${o.id}-${line.id}`, type: 'outbound', typeLabel: '销售出库', cls: 'blue', batch, skuId: line.skuId, skuName, delta: -line.quantity, refNo: o.orderNo, actor: '系统（自动）', time: o.createdAt });
        } else if (o.status === 'draft' || o.status === 'confirmed' || o.status === 'paid') {
          rows.push({ id: `res-${o.id}-${line.id}`, type: 'reserve', typeLabel: '库存占用', cls: 'orange', batch, skuId: line.skuId, skuName, delta: line.quantity, refNo: o.orderNo, actor: '系统（自动）', time: o.createdAt });
        }
      }
    }
    rows.sort((a, b) => b.time.localeCompare(a.time));
    const kw = query.keyword?.trim().toLowerCase() ?? '';
    const filtered = rows.filter((r) => {
      if (query.type && r.type !== query.type) return false;
      if (kw && !`${r.batch} ${r.refNo}`.toLowerCase().includes(kw)) return false;
      return true;
    });
    return paginate(filtered, query);
  }
}
