-- Portal Unidades — cadastro aprovado por UBS, inventário por salas e pedidos permanentes.
-- Projeto Supabase autorizado: qpvgpfwuurqcqprnpxua (contratos-dag).

create table if not exists public.portal_unidades_acessos (
  user_id uuid primary key references auth.users(id) on delete cascade,
  unidade_solicitada_id bigint not null references public.unidades(id),
  unidade_id bigint references public.unidades(id),
  status text not null default 'PENDENTE'
    check (status in ('PENDENTE','APROVADO','REJEITADO')),
  solicitado_em timestamptz not null default now(),
  revisado_em timestamptz,
  revisado_por uuid references auth.users(id),
  observacao_revisao text,
  constraint portal_acesso_aprovado_com_unidade
    check (status <> 'APROVADO' or unidade_id is not null)
);

create table if not exists public.portal_salas (
  id uuid primary key default gen_random_uuid(),
  unidade_id bigint not null references public.unidades(id),
  nome text not null check (length(trim(nome)) between 2 and 120),
  descricao text,
  ativo boolean not null default true,
  criado_por uuid references auth.users(id),
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  unique (id, unidade_id)
);

create unique index if not exists portal_salas_unidade_nome_ativo_uq
  on public.portal_salas (unidade_id, lower(trim(nome)))
  where ativo is true;

create table if not exists public.portal_inventario (
  id uuid primary key default gen_random_uuid(),
  unidade_id bigint not null references public.unidades(id),
  sala_id uuid not null,
  item_nome text not null check (length(trim(item_nome)) between 2 and 180),
  categoria text,
  quantidade integer not null default 1 check (quantidade > 0),
  patrimonio text,
  numero_serie text,
  marca text,
  modelo text,
  estado text not null default 'BOM'
    check (estado in ('NOVO','BOM','REGULAR','RUIM','INSERVIVEL')),
  observacoes text,
  ativo boolean not null default true,
  criado_por uuid references auth.users(id),
  atualizado_por uuid references auth.users(id),
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  constraint portal_inventario_sala_unidade_fk
    foreign key (sala_id, unidade_id)
    references public.portal_salas(id, unidade_id)
);

create index if not exists portal_inventario_unidade_idx
  on public.portal_inventario (unidade_id, ativo);
create index if not exists portal_inventario_sala_idx
  on public.portal_inventario (sala_id, ativo);
create index if not exists portal_inventario_sala_unidade_idx
  on public.portal_inventario (sala_id, unidade_id);
create index if not exists portal_inventario_criado_por_idx
  on public.portal_inventario (criado_por);
create index if not exists portal_inventario_atualizado_por_idx
  on public.portal_inventario (atualizado_por);

create table if not exists public.portal_pedidos_itens (
  id uuid primary key default gen_random_uuid(),
  unidade_id bigint not null references public.unidades(id),
  item_nome text not null check (length(trim(item_nome)) between 2 and 180),
  categoria text,
  quantidade integer not null default 1 check (quantidade > 0),
  unidade_medida text not null default 'UNIDADE'
    check (unidade_medida in ('UNIDADE','CAIXA','PACOTE','KIT','LITRO','METRO')),
  especificacao text,
  justificativa text,
  prioridade text not null default 'NORMAL'
    check (prioridade in ('BAIXA','NORMAL','ALTA','URGENTE')),
  status text not null default 'ATIVO'
    check (status in ('ATIVO','CANCELADO','ATENDIDO')),
  criado_por uuid references auth.users(id),
  atualizado_por uuid references auth.users(id),
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  cancelado_em timestamptz,
  atendido_em timestamptz
);

create index if not exists portal_pedidos_unidade_status_idx
  on public.portal_pedidos_itens (unidade_id, status);
create index if not exists portal_pedidos_item_ativo_idx
  on public.portal_pedidos_itens (lower(trim(item_nome)))
  where status = 'ATIVO';
create index if not exists portal_pedidos_criado_por_idx
  on public.portal_pedidos_itens (criado_por);
create index if not exists portal_pedidos_atualizado_por_idx
  on public.portal_pedidos_itens (atualizado_por);
create index if not exists portal_acessos_unidade_solicitada_idx
  on public.portal_unidades_acessos (unidade_solicitada_id);
create index if not exists portal_acessos_unidade_idx
  on public.portal_unidades_acessos (unidade_id);
create index if not exists portal_acessos_revisado_por_idx
  on public.portal_unidades_acessos (revisado_por);
create index if not exists portal_salas_criado_por_idx
  on public.portal_salas (criado_por);

create or replace function private.portal_unidade_aprovada(p_unidade_id bigint)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.portal_unidades_acessos a
    where a.user_id = auth.uid()
      and a.status = 'APROVADO'
      and a.unidade_id = p_unidade_id
  );
$$;

revoke all on function private.portal_unidade_aprovada(bigint) from public;
grant execute on function private.portal_unidade_aprovada(bigint) to authenticated;

create or replace function private.portal_set_atualizado_em()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.atualizado_em := now();
  if tg_table_name in ('portal_inventario','portal_pedidos_itens') then
    new.atualizado_por := auth.uid();
  end if;
  return new;
end;
$$;

create or replace function private.portal_guardar_pedido()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' and not private.is_admin_approved() then
    if new.unidade_id is distinct from old.unidade_id
      or new.criado_por is distinct from old.criado_por then
      raise exception 'Não é permitido transferir o pedido para outra unidade.' using errcode='42501';
    end if;
    if new.status = 'ATENDIDO' or old.status = 'ATENDIDO' then
      raise exception 'Somente administradores podem marcar ou alterar item atendido.' using errcode='42501';
    end if;
  end if;
  if new.status = 'CANCELADO' and old.status is distinct from 'CANCELADO' then
    new.cancelado_em := now();
  elsif new.status <> 'CANCELADO' then
    new.cancelado_em := null;
  end if;
  if new.status = 'ATENDIDO' and old.status is distinct from 'ATENDIDO' then
    new.atendido_em := now();
  elsif new.status <> 'ATENDIDO' then
    new.atendido_em := null;
  end if;
  return new;
end;
$$;

create or replace function private.portal_registrar_revisao_acesso()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not private.is_admin_approved() then
    raise exception 'Somente administradores podem revisar acessos.' using errcode='42501';
  end if;
  if new.status = 'APROVADO' and new.unidade_id is null then
    new.unidade_id := new.unidade_solicitada_id;
  end if;
  if new.status is distinct from old.status
    or new.unidade_id is distinct from old.unidade_id then
    new.revisado_em := now();
    new.revisado_por := auth.uid();
  end if;
  return new;
end;
$$;

create or replace function private.portal_criar_solicitacao_cadastro()
returns trigger
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_unidade_text text;
  v_unidade_id bigint;
  v_nome text;
begin
  if coalesce(new.raw_user_meta_data ->> 'portal_unidades','false') <> 'true' then
    return new;
  end if;

  v_unidade_text := new.raw_user_meta_data ->> 'unidade_id';
  if v_unidade_text is null or v_unidade_text !~ '^[0-9]+$' then
    raise exception 'Selecione uma unidade válida para o Portal Unidades.';
  end if;
  v_unidade_id := v_unidade_text::bigint;
  if not exists (select 1 from public.unidades where id=v_unidade_id and ativo is true) then
    raise exception 'A unidade selecionada não está disponível.';
  end if;

  v_nome := nullif(trim(new.raw_user_meta_data ->> 'nome'),'');
  insert into public.profiles (id,nome,email,papel,aprovado)
  values (new.id,coalesce(v_nome,split_part(new.email,'@',1)),new.email,'visualizador',false)
  on conflict (id) do nothing;

  insert into public.portal_unidades_acessos (user_id,unidade_solicitada_id,status)
  values (new.id,v_unidade_id,'PENDENTE')
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists portal_auth_criar_solicitacao on auth.users;
create trigger portal_auth_criar_solicitacao
  after insert on auth.users
  for each row execute function private.portal_criar_solicitacao_cadastro();

drop trigger if exists portal_salas_atualizado on public.portal_salas;
create trigger portal_salas_atualizado before update on public.portal_salas
  for each row execute function private.portal_set_atualizado_em();
drop trigger if exists portal_inventario_atualizado on public.portal_inventario;
create trigger portal_inventario_atualizado before update on public.portal_inventario
  for each row execute function private.portal_set_atualizado_em();
drop trigger if exists portal_pedidos_atualizado on public.portal_pedidos_itens;
create trigger portal_pedidos_atualizado before update on public.portal_pedidos_itens
  for each row execute function private.portal_set_atualizado_em();
drop trigger if exists portal_pedidos_guard on public.portal_pedidos_itens;
create trigger portal_pedidos_guard before update on public.portal_pedidos_itens
  for each row execute function private.portal_guardar_pedido();
drop trigger if exists portal_acesso_revisao on public.portal_unidades_acessos;
create trigger portal_acesso_revisao before update on public.portal_unidades_acessos
  for each row execute function private.portal_registrar_revisao_acesso();

alter table public.portal_unidades_acessos enable row level security;
alter table public.portal_salas enable row level security;
alter table public.portal_inventario enable row level security;
alter table public.portal_pedidos_itens enable row level security;

drop policy if exists portal_acessos_select on public.portal_unidades_acessos;
create policy portal_acessos_select on public.portal_unidades_acessos
  for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_admin_approved()));

drop policy if exists portal_acessos_update_admin on public.portal_unidades_acessos;
create policy portal_acessos_update_admin on public.portal_unidades_acessos
  for update to authenticated
  using ((select private.is_admin_approved()))
  with check ((select private.is_admin_approved()));

drop policy if exists portal_salas_select on public.portal_salas;
create policy portal_salas_select on public.portal_salas
  for select to authenticated
  using (private.portal_unidade_aprovada(unidade_id) or (select private.is_admin_approved()));
drop policy if exists portal_salas_insert on public.portal_salas;
create policy portal_salas_insert on public.portal_salas
  for insert to authenticated
  with check (
    (private.portal_unidade_aprovada(unidade_id) and criado_por=(select auth.uid()))
    or (select private.is_admin_approved())
  );
drop policy if exists portal_salas_update on public.portal_salas;
create policy portal_salas_update on public.portal_salas
  for update to authenticated
  using (private.portal_unidade_aprovada(unidade_id) or (select private.is_admin_approved()))
  with check (private.portal_unidade_aprovada(unidade_id) or (select private.is_admin_approved()));

drop policy if exists portal_inventario_select on public.portal_inventario;
create policy portal_inventario_select on public.portal_inventario
  for select to authenticated
  using (private.portal_unidade_aprovada(unidade_id) or (select private.is_admin_approved()));
drop policy if exists portal_inventario_insert on public.portal_inventario;
create policy portal_inventario_insert on public.portal_inventario
  for insert to authenticated
  with check (
    (private.portal_unidade_aprovada(unidade_id) and criado_por=(select auth.uid()))
    or (select private.is_admin_approved())
  );
drop policy if exists portal_inventario_update on public.portal_inventario;
create policy portal_inventario_update on public.portal_inventario
  for update to authenticated
  using (private.portal_unidade_aprovada(unidade_id) or (select private.is_admin_approved()))
  with check (private.portal_unidade_aprovada(unidade_id) or (select private.is_admin_approved()));

drop policy if exists portal_pedidos_select on public.portal_pedidos_itens;
create policy portal_pedidos_select on public.portal_pedidos_itens
  for select to authenticated
  using (private.portal_unidade_aprovada(unidade_id) or (select private.is_admin_approved()));
drop policy if exists portal_pedidos_insert on public.portal_pedidos_itens;
create policy portal_pedidos_insert on public.portal_pedidos_itens
  for insert to authenticated
  with check (
    (private.portal_unidade_aprovada(unidade_id) and criado_por=(select auth.uid()))
    or (select private.is_admin_approved())
  );
drop policy if exists portal_pedidos_update on public.portal_pedidos_itens;
create policy portal_pedidos_update on public.portal_pedidos_itens
  for update to authenticated
  using (private.portal_unidade_aprovada(unidade_id) or (select private.is_admin_approved()))
  with check (private.portal_unidade_aprovada(unidade_id) or (select private.is_admin_approved()));

grant select,update on public.portal_unidades_acessos to authenticated;
grant select,insert,update on public.portal_salas to authenticated;
grant select,insert,update on public.portal_inventario to authenticated;
grant select,insert,update on public.portal_pedidos_itens to authenticated;

create or replace view public.portal_pedidos_consolidados
with (security_invoker=true)
as
select
  lower(regexp_replace(trim(item_nome),'\s+',' ','g')) as item_chave,
  min(item_nome) as item_nome,
  min(categoria) as categoria,
  unidade_medida,
  sum(quantidade)::bigint as quantidade_total,
  count(distinct unidade_id)::bigint as total_unidades,
  max(atualizado_em) as atualizado_em
from public.portal_pedidos_itens
where status='ATIVO'
group by lower(regexp_replace(trim(item_nome),'\s+',' ','g')), unidade_medida;

grant select on public.portal_pedidos_consolidados to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname='supabase_realtime') then
    begin alter publication supabase_realtime add table public.portal_unidades_acessos; exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.portal_salas; exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.portal_inventario; exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.portal_pedidos_itens; exception when duplicate_object then null; end;
  end if;
end $$;

notify pgrst, 'reload schema';
