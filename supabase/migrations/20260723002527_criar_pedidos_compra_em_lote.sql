create or replace function public.portal_criar_pedidos_lote(
  p_sala_id uuid,
  p_itens jsonb
)
returns setof public.portal_pedidos_itens
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_unidade_id bigint;
  v_total integer;
  v_distintos integer;
begin
  if jsonb_typeof(p_itens) <> 'array' then
    raise exception 'A lista de pedidos é inválida.' using errcode = '22023';
  end if;

  v_total := jsonb_array_length(p_itens);
  if v_total < 1 or v_total > 100 then
    raise exception 'A lista deve conter entre 1 e 100 itens.' using errcode = '22023';
  end if;

  select s.unidade_id
  into v_unidade_id
  from public.portal_salas s
  where s.id = p_sala_id
    and s.ativo is true;

  if v_unidade_id is null then
    raise exception 'A sala selecionada não está disponível para pedido.' using errcode = '23514';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_itens) as item(
      client_request_id uuid,
      item_nome text,
      quantidade integer,
      prioridade text,
      justificativa text
    )
    where item.client_request_id is null
       or item.item_nome is null
       or trim(item.item_nome) = ''
       or item.quantidade is null
       or item.quantidade < 1
       or item.quantidade > 100000
       or item.prioridade not in ('BAIXA','NORMAL','ALTA','URGENTE')
       or item.justificativa is null
       or trim(item.justificativa) = ''
  ) then
    raise exception 'Preencha corretamente todos os itens da lista.' using errcode = '23514';
  end if;

  select count(distinct item.client_request_id)
  into v_distintos
  from jsonb_to_recordset(p_itens) as item(client_request_id uuid);

  if v_distintos <> v_total then
    raise exception 'A lista contém identificadores repetidos.' using errcode = '23505';
  end if;

  insert into public.portal_pedidos_itens (
    client_request_id,
    unidade_id,
    sala_id,
    item_nome,
    categoria,
    quantidade,
    unidade_medida,
    prioridade,
    justificativa,
    criado_por,
    atualizado_por
  )
  select
    item.client_request_id,
    v_unidade_id,
    p_sala_id,
    trim(item.item_nome),
    null,
    item.quantidade,
    'UNIDADE',
    item.prioridade,
    trim(item.justificativa),
    auth.uid(),
    auth.uid()
  from jsonb_to_recordset(p_itens) as item(
    client_request_id uuid,
    item_nome text,
    quantidade integer,
    prioridade text,
    justificativa text
  )
  on conflict (client_request_id) do nothing;

  return query
  select pedido.*
  from public.portal_pedidos_itens pedido
  where pedido.client_request_id in (
    select item.client_request_id
    from jsonb_to_recordset(p_itens) as item(client_request_id uuid)
  )
  order by pedido.criado_em;
end;
$$;

revoke all on function public.portal_criar_pedidos_lote(uuid,jsonb) from public;
grant execute on function public.portal_criar_pedidos_lote(uuid,jsonb) to authenticated;
