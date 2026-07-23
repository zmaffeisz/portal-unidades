-- Concorrência e integridade do Portal Unidades.
-- Pedidos usam uma chave idempotente do navegador; alterações de quantidade são
-- feitas em uma única instrução SQL; inventário representa um objeto por linha.

begin;

-- Um pedido reenviado após perda de resposta não pode criar uma segunda linha.
alter table public.portal_pedidos_itens
  add column if not exists client_request_id uuid default gen_random_uuid();

update public.portal_pedidos_itens
set client_request_id = gen_random_uuid()
where client_request_id is null;

alter table public.portal_pedidos_itens
  alter column client_request_id set not null;

create unique index if not exists portal_pedidos_client_request_id_uq
  on public.portal_pedidos_itens (client_request_id);

-- Cada equipamento ou móvel deve ter seu próprio registro físico. Ao dividir
-- lançamentos antigos, patrimônio e série ficam somente no primeiro objeto.
insert into public.portal_inventario (
  unidade_id, sala_id, item_nome, categoria, quantidade, patrimonio,
  numero_serie, marca, modelo, estado, observacoes, ativo, criado_por,
  atualizado_por, criado_em, atualizado_em
)
select
  i.unidade_id,
  i.sala_id,
  i.item_nome,
  i.categoria,
  1,
  null,
  null,
  i.marca,
  i.modelo,
  i.estado,
  concat_ws(E'\n', i.observacoes, 'Registro individualizado de lançamento anterior.'),
  i.ativo,
  i.criado_por,
  i.atualizado_por,
  i.criado_em,
  i.atualizado_em
from public.portal_inventario i
cross join lateral generate_series(2, i.quantidade) as unidade(numero)
where i.quantidade > 1;

update public.portal_inventario
set quantidade = 1
where quantidade <> 1;

alter table public.portal_inventario
  drop constraint if exists portal_inventario_quantidade_uma_unidade_ck;

alter table public.portal_inventario
  add constraint portal_inventario_quantidade_uma_unidade_ck
  check (quantidade = 1);

-- Índices de cobertura para as listagens por unidade, que são a consulta mais
-- frequente de coordenadores e gestores.
create index if not exists portal_inventario_unidade_ativo_item_idx
  on public.portal_inventario (unidade_id, ativo, item_nome);

create index if not exists portal_pedidos_unidade_status_atualizado_idx
  on public.portal_pedidos_itens (unidade_id, status, atualizado_em desc);

create or replace function public.portal_criar_pedido(
  p_request_id uuid,
  p_sala_id uuid,
  p_item_nome text,
  p_quantidade integer,
  p_unidade_medida text,
  p_prioridade text,
  p_justificativa text
)
returns setof public.portal_pedidos_itens
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_unidade_id bigint;
begin
  if p_request_id is null then
    raise exception 'Identificador da solicitação é obrigatório.' using errcode = '23502';
  end if;

  if p_quantidade is null or p_quantidade < 1 then
    raise exception 'A quantidade deve ser pelo menos 1.' using errcode = '23514';
  end if;

  select s.unidade_id
  into v_unidade_id
  from public.portal_salas s
  where s.id = p_sala_id
    and s.ativo is true;

  if v_unidade_id is null then
    raise exception 'A sala selecionada não está disponível para pedido.' using errcode = '23514';
  end if;

  insert into public.portal_pedidos_itens (
    client_request_id, unidade_id, sala_id, item_nome, quantidade,
    unidade_medida, prioridade, justificativa, criado_por, atualizado_por
  )
  values (
    p_request_id, v_unidade_id, p_sala_id, trim(p_item_nome),
    p_quantidade, p_unidade_medida, p_prioridade, nullif(trim(p_justificativa), ''),
    auth.uid(), auth.uid()
  )
  on conflict (client_request_id) do nothing;

  return query
  select p.*
  from public.portal_pedidos_itens p
  where p.client_request_id = p_request_id;
end;
$$;

revoke all on function public.portal_criar_pedido(uuid, uuid, text, integer, text, text, text) from public;
grant execute on function public.portal_criar_pedido(uuid, uuid, text, integer, text, text, text) to authenticated;

create or replace function public.portal_alterar_quantidade_pedido(
  p_pedido_id uuid,
  p_delta integer
)
returns public.portal_pedidos_itens
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_pedido public.portal_pedidos_itens;
begin
  if p_delta not in (-1, 1) then
    raise exception 'O ajuste de quantidade deve ser de uma unidade.' using errcode = '22023';
  end if;

  update public.portal_pedidos_itens
  set quantidade = quantidade + p_delta,
      atualizado_por = auth.uid()
  where id = p_pedido_id
    and status = 'ATIVO'
    and quantidade + p_delta >= 1
  returning * into v_pedido;

  if not found then
    raise exception 'O pedido não está disponível para esse ajuste.' using errcode = 'P0002';
  end if;

  return v_pedido;
end;
$$;

revoke all on function public.portal_alterar_quantidade_pedido(uuid, integer) from public;
grant execute on function public.portal_alterar_quantidade_pedido(uuid, integer) to authenticated;

comment on column public.portal_pedidos_itens.client_request_id is
  'Chave idempotente enviada pelo navegador para evitar pedido duplicado após nova tentativa.';

commit;
