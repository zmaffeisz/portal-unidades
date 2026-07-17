-- Pedidos novos devem informar uma sala ativa da mesma unidade. Pedidos anteriores
-- permanecem com sala nula até que alguém os classifique, sem bloquear seus ajustes.
-- Projeto Supabase autorizado: qpvgpfwuurqcqprnpxua (contratos-dag).

alter table public.portal_pedidos_itens
  add column if not exists sala_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'portal_pedidos_sala_unidade_fk'
      and conrelid = 'public.portal_pedidos_itens'::regclass
  ) then
    alter table public.portal_pedidos_itens
      add constraint portal_pedidos_sala_unidade_fk
      foreign key (sala_id, unidade_id)
      references public.portal_salas(id, unidade_id);
  end if;
end
$$;

create index if not exists portal_pedidos_sala_idx
  on public.portal_pedidos_itens (sala_id)
  where sala_id is not null;

comment on column public.portal_pedidos_itens.sala_id is
  'Sala destinatária do pedido. Obrigatória em novos pedidos; nula somente para registros anteriores a 2026-07-17.';

create or replace function private.portal_validar_sala_pedido()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if new.sala_id is null then
    if tg_op = 'INSERT' then
      raise exception 'Selecione a sala que receberá o item.' using errcode = '23514';
    end if;
    if old.sala_id is not null then
      raise exception 'Selecione a sala que receberá o item.' using errcode = '23514';
    end if;
    return new;
  end if;

  if not exists (
    select 1
    from public.portal_salas s
    where s.id = new.sala_id
      and s.unidade_id = new.unidade_id
      and s.ativo is true
  ) then
    raise exception 'A sala selecionada não está ativa ou não pertence a esta unidade.' using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function private.portal_validar_sala_pedido() from public;

drop trigger if exists portal_pedidos_validar_sala on public.portal_pedidos_itens;
create trigger portal_pedidos_validar_sala
  before insert or update of sala_id, unidade_id
  on public.portal_pedidos_itens
  for each row execute function private.portal_validar_sala_pedido();

notify pgrst, 'reload schema';
