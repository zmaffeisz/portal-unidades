-- Mantém a função RPC pública como SECURITY INVOKER. A leitura mínima de nome/e-mail
-- fica isolada em helper privado, protegido pela mesma regra de gestão do portal.
-- Projeto Supabase autorizado: qpvgpfwuurqcqprnpxua (contratos-dag).

create or replace function private.portal_perfil_resumo(p_user_id uuid)
returns table (
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
  select p.nome, p.email
  from public.profiles p
  where p.id = p_user_id;
end;
$$;

revoke all on function private.portal_perfil_resumo(uuid) from public;
grant execute on function private.portal_perfil_resumo(uuid) to authenticated;

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
security invoker
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
    perfil.nome,
    perfil.email
  from public.portal_unidades_acessos a
  left join lateral private.portal_perfil_resumo(a.user_id) perfil on true
  order by a.solicitado_em desc;
end;
$$;

revoke all on function public.portal_listar_solicitacoes_acesso() from public;
revoke all on function public.portal_listar_solicitacoes_acesso() from anon;
grant execute on function public.portal_listar_solicitacoes_acesso() to authenticated;

notify pgrst, 'reload schema';
