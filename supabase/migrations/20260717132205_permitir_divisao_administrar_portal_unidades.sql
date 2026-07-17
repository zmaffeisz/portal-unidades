-- Perfis aprovados com escopo de divisão administram somente o Portal Unidades,
-- sem receber o papel global de administrador do dashboard principal.
-- Projeto Supabase autorizado: qpvgpfwuurqcqprnpxua (contratos-dag).

create or replace function private.portal_pode_administrar()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid())
      and p.aprovado is true
      and (
        p.papel = 'admin'
        or p.escopo_organizacional = 'divisao'
      )
  );
$$;

revoke all on function private.portal_pode_administrar() from public;
grant execute on function private.portal_pode_administrar() to authenticated;

comment on function private.portal_pode_administrar() is
  'Autoriza a gestão completa apenas no Portal Unidades para admin aprovado ou perfil aprovado com escopo divisao.';

create or replace function private.portal_guardar_pedido()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not private.portal_pode_administrar() then
    if new.unidade_id is distinct from old.unidade_id
      or new.criado_por is distinct from old.criado_por then
      raise exception 'Não é permitido transferir o pedido para outra unidade.' using errcode='42501';
    end if;
    if new.status = 'ATENDIDO' or old.status = 'ATENDIDO' then
      raise exception 'Somente gestores do Portal Unidades podem marcar ou alterar item atendido.' using errcode='42501';
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
  if not private.portal_pode_administrar() then
    raise exception 'Somente gestores do Portal Unidades podem revisar acessos.' using errcode='42501';
  end if;
  if new.status = 'APROVADO' and new.unidade_id is null then
    new.unidade_id := new.unidade_solicitada_id;
  end if;
  if new.status is distinct from old.status
    or new.unidade_id is distinct from old.unidade_id then
    new.revisado_em := now();
    new.revisado_por := (select auth.uid());
  end if;
  return new;
end;
$$;

drop policy if exists portal_acessos_select on public.portal_unidades_acessos;
create policy portal_acessos_select on public.portal_unidades_acessos
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or (select private.portal_pode_administrar())
  );

drop policy if exists portal_acessos_update_admin on public.portal_unidades_acessos;
create policy portal_acessos_update_admin on public.portal_unidades_acessos
  for update to authenticated
  using ((select private.portal_pode_administrar()))
  with check ((select private.portal_pode_administrar()));

drop policy if exists portal_salas_select on public.portal_salas;
create policy portal_salas_select on public.portal_salas
  for select to authenticated
  using (
    private.portal_unidade_aprovada(unidade_id)
    or (select private.portal_pode_administrar())
  );

drop policy if exists portal_salas_insert on public.portal_salas;
create policy portal_salas_insert on public.portal_salas
  for insert to authenticated
  with check (
    (private.portal_unidade_aprovada(unidade_id) and criado_por = (select auth.uid()))
    or (select private.portal_pode_administrar())
  );

drop policy if exists portal_salas_update on public.portal_salas;
create policy portal_salas_update on public.portal_salas
  for update to authenticated
  using (
    private.portal_unidade_aprovada(unidade_id)
    or (select private.portal_pode_administrar())
  )
  with check (
    private.portal_unidade_aprovada(unidade_id)
    or (select private.portal_pode_administrar())
  );

drop policy if exists portal_inventario_select on public.portal_inventario;
create policy portal_inventario_select on public.portal_inventario
  for select to authenticated
  using (
    private.portal_unidade_aprovada(unidade_id)
    or (select private.portal_pode_administrar())
  );

drop policy if exists portal_inventario_insert on public.portal_inventario;
create policy portal_inventario_insert on public.portal_inventario
  for insert to authenticated
  with check (
    (private.portal_unidade_aprovada(unidade_id) and criado_por = (select auth.uid()))
    or (select private.portal_pode_administrar())
  );

drop policy if exists portal_inventario_update on public.portal_inventario;
create policy portal_inventario_update on public.portal_inventario
  for update to authenticated
  using (
    private.portal_unidade_aprovada(unidade_id)
    or (select private.portal_pode_administrar())
  )
  with check (
    private.portal_unidade_aprovada(unidade_id)
    or (select private.portal_pode_administrar())
  );

drop policy if exists portal_pedidos_select on public.portal_pedidos_itens;
create policy portal_pedidos_select on public.portal_pedidos_itens
  for select to authenticated
  using (
    private.portal_unidade_aprovada(unidade_id)
    or (select private.portal_pode_administrar())
  );

drop policy if exists portal_pedidos_insert on public.portal_pedidos_itens;
create policy portal_pedidos_insert on public.portal_pedidos_itens
  for insert to authenticated
  with check (
    (private.portal_unidade_aprovada(unidade_id) and criado_por = (select auth.uid()))
    or (select private.portal_pode_administrar())
  );

drop policy if exists portal_pedidos_update on public.portal_pedidos_itens;
create policy portal_pedidos_update on public.portal_pedidos_itens
  for update to authenticated
  using (
    private.portal_unidade_aprovada(unidade_id)
    or (select private.portal_pode_administrar())
  )
  with check (
    private.portal_unidade_aprovada(unidade_id)
    or (select private.portal_pode_administrar())
  );

create or replace function public.portal_listar_solicitacoes_acesso()
returns table (
  user_id uuid,
  unidade_solicitada_id bigint,
  unidade_id bigint,
  status text,
  solicitado_em timestamptz,
  revisado_em timestamptz,
  revisado_por uuid,
  observacao_revisao text,
  nome text,
  email text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not private.portal_pode_administrar() then
    raise exception 'Acesso restrito aos gestores do Portal Unidades.' using errcode='42501';
  end if;

  return query
  select
    a.user_id,
    a.unidade_solicitada_id,
    a.unidade_id,
    a.status,
    a.solicitado_em,
    a.revisado_em,
    a.revisado_por,
    a.observacao_revisao,
    p.nome,
    p.email
  from public.portal_unidades_acessos a
  left join public.profiles p on p.id = a.user_id
  order by a.solicitado_em desc;
end;
$$;

revoke all on function public.portal_listar_solicitacoes_acesso() from public;
revoke all on function public.portal_listar_solicitacoes_acesso() from anon;
grant execute on function public.portal_listar_solicitacoes_acesso() to authenticated;

comment on function public.portal_listar_solicitacoes_acesso() is
  'Lista somente os dados mínimos necessários para gestores revisarem acessos ao Portal Unidades.';

notify pgrst, 'reload schema';
