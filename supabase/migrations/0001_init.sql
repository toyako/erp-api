-- ERP Platform 初始迁移
-- 与 apps/erp-api/prisma/schema.prisma 对应；仅结构定义，不含任何真实数据。
-- 执行方式：supabase db push（远程）或 supabase db reset（本地）

create extension if not exists pgcrypto;

create table if not exists tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists principals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  username text not null unique,
  display_name text not null,
  roles text[] not null default '{}',
  password_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists spus (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  name text not null,
  category_code text not null,
  description text,
  enabled boolean not null default true
);

create table if not exists skus (
  id uuid primary key default gen_random_uuid(),
  spu_id uuid not null references spus(id),
  code text not null unique,
  spec text not null,
  unit text not null,
  enabled boolean not null default true
);

create table if not exists price_lists (
  id uuid primary key default gen_random_uuid(),
  sku_id uuid not null references skus(id),
  channel_code text not null,
  amount integer not null check (amount >= 0),
  currency char(3) not null,
  effective_from timestamptz not null,
  effective_to timestamptz
);
create index if not exists price_lists_sku_channel_idx on price_lists (sku_id, channel_code);

create table if not exists inventory_lots (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  sku_id uuid not null references skus(id),
  batch_code text not null,
  available_qty integer not null default 0 check (available_qty >= 0),
  reserved_qty integer not null default 0 check (reserved_qty >= 0),
  total_qty integer not null default 0 check (total_qty >= 0)
);
create index if not exists inventory_lots_sku_idx on inventory_lots (sku_id);

create table if not exists stock_movements (
  id uuid primary key default gen_random_uuid(),
  lot_id uuid not null references inventory_lots(id),
  type text not null,
  quantity integer not null check (quantity > 0),
  reference_id uuid,
  created_at timestamptz not null default now()
);

create table if not exists sales_orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  order_no text not null unique,
  status text not null,
  amount integer not null check (amount >= 0),
  currency char(3) not null,
  created_at timestamptz not null default now()
);
create index if not exists sales_orders_tenant_status_idx on sales_orders (tenant_id, status);

create table if not exists order_lines (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references sales_orders(id),
  sku_id uuid not null references skus(id),
  quantity integer not null check (quantity > 0),
  unit_amount integer not null check (unit_amount >= 0),
  currency char(3) not null
);
create index if not exists order_lines_order_idx on order_lines (order_id);

create table if not exists payment_records (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references sales_orders(id),
  amount integer not null check (amount >= 0),
  currency char(3) not null,
  reference text not null,
  created_at timestamptz not null default now()
);

create table if not exists audit_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  actor_id uuid not null,
  action text not null,
  target_type text not null,
  target_id text not null,
  payload jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_events_tenant_created_idx on audit_events (tenant_id, created_at);
