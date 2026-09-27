-- INE Price Tracker schema

create table if not exists tracked_products (
  id uuid primary key default gen_random_uuid(),
  store_product_id text not null,       -- id as shown in product page URL
  product_name text not null,
  option_name text not null,            -- e.g. storage size / kit / pack size
  product_url text not null,
  scrape_interval_minutes int not null default 120,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (store_product_id, option_name)
);

create table if not exists scrape_log (
  id uuid primary key default gen_random_uuid(),
  tracked_product_id uuid not null references tracked_products(id) on delete cascade,
  attempted_at timestamptz not null default now(),
  outcome text not null check (outcome in ('success', 'retried', 'failed')),
  attempt_count int not null default 1,
  price numeric,                        -- null when outcome = failed
  stock text,                           -- null when outcome = failed (e.g. "in_stock" / "out_of_stock" / count)
  error_message text,
  duration_ms int
);

create index if not exists idx_scrape_log_product on scrape_log(tracked_product_id, attempted_at desc);

-- convenience view: latest known state per tracked product
create or replace view latest_price as
select distinct on (tracked_product_id)
  tracked_product_id, price, stock, attempted_at, outcome
from scrape_log
where outcome != 'failed'
order by tracked_product_id, attempted_at desc;
