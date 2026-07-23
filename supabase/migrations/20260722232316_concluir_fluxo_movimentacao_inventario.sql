begin;

create index if not exists portal_transferencias_destino_status_idx on public.portal_transferencias_inventario(unidade_destino_id,status,enviado_em desc);
create index if not exists portal_transferencias_origem_status_idx on public.portal_transferencias_inventario(unidade_origem_id,status,enviado_em desc);

do $$ begin
  alter table public.portal_transferencias_inventario add constraint portal_transferencias_inventario_origem_fk foreign key(inventario_origem_id) references public.portal_inventario(id);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.portal_transferencias_inventario add constraint portal_transferencias_unidade_origem_fk foreign key(unidade_origem_id) references public.unidades(id);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.portal_transferencias_inventario add constraint portal_transferencias_unidade_destino_fk foreign key(unidade_destino_id) references public.unidades(id);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.portal_transferencias_inventario add constraint portal_transferencias_sala_destino_fk foreign key(sala_destino_id,unidade_destino_id) references public.portal_salas(id,unidade_id);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.portal_transferencias_inventario add constraint portal_transferencias_unidades_distintas_ck check(unidade_origem_id<>unidade_destino_id);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.portal_transferencias_inventario add constraint portal_transferencias_recebimento_consistente_ck check(status<>'RECEBIDA' or (recebido_por is not null and recebido_em is not null and sala_destino_id is not null));
exception when duplicate_object then null; end $$;

drop policy if exists transferencias_insert on public.portal_transferencias_inventario;
drop policy if exists transferencias_update on public.portal_transferencias_inventario;
revoke insert,update on public.portal_transferencias_inventario from authenticated;

create or replace function private.portal_transferir_inventario_impl(p_item_id uuid,p_unidade_destino bigint)
returns public.portal_transferencias_inventario language plpgsql security definer set search_path=public,private,pg_temp as $$
declare i public.portal_inventario; t public.portal_transferencias_inventario;
begin
  if auth.uid() is null then raise exception 'Autenticação obrigatória.' using errcode='42501'; end if;
  select * into i from public.portal_inventario where id=p_item_id and ativo for update;
  if not found or not (private.portal_unidade_aprovada(i.unidade_id) or private.portal_pode_administrar()) then raise exception 'Item não disponível para transferência.' using errcode='42501'; end if;
  if p_unidade_destino=i.unidade_id or not exists(select 1 from public.unidades where id=p_unidade_destino and ativo) then raise exception 'Unidade de destino inválida.' using errcode='23514'; end if;
  update public.portal_inventario set ativo=false,atualizado_por=auth.uid() where id=i.id;
  insert into public.portal_transferencias_inventario(inventario_origem_id,unidade_origem_id,unidade_destino_id,item,enviado_por)
  values(i.id,i.unidade_id,p_unidade_destino,to_jsonb(i),auth.uid()) returning * into t;
  return t;
end $$;

create or replace function private.portal_receber_transferencia_impl(p_transferencia_id uuid,p_sala_id uuid)
returns public.portal_inventario language plpgsql security definer set search_path=public,private,pg_temp as $$
declare t public.portal_transferencias_inventario; r public.portal_inventario;
begin
  if auth.uid() is null then raise exception 'Autenticação obrigatória.' using errcode='42501'; end if;
  select * into t from public.portal_transferencias_inventario where id=p_transferencia_id and status='PENDENTE' for update;
  if not found or not (private.portal_unidade_aprovada(t.unidade_destino_id) or private.portal_pode_administrar()) then raise exception 'Transferência não disponível para recebimento.' using errcode='42501'; end if;
  if not exists(select 1 from public.portal_salas where id=p_sala_id and unidade_id=t.unidade_destino_id and ativo) then raise exception 'Selecione uma sala ativa da unidade de destino.' using errcode='23514'; end if;
  insert into public.portal_inventario(unidade_id,sala_id,item_nome,categoria,quantidade,patrimonio,numero_serie,marca,modelo,estado,observacoes,criado_por,atualizado_por)
  values(t.unidade_destino_id,p_sala_id,t.item->>'item_nome',nullif(t.item->>'categoria',''),1,nullif(t.item->>'patrimonio',''),nullif(t.item->>'numero_serie',''),nullif(t.item->>'marca',''),nullif(t.item->>'modelo',''),coalesce(nullif(t.item->>'estado',''),'BOM'),nullif(t.item->>'observacoes',''),auth.uid(),auth.uid()) returning * into r;
  update public.portal_transferencias_inventario set status='RECEBIDA',recebido_por=auth.uid(),recebido_em=now(),sala_destino_id=p_sala_id where id=t.id;
  return r;
end $$;

revoke all on function private.portal_transferir_inventario_impl(uuid,bigint),private.portal_receber_transferencia_impl(uuid,uuid) from public;
grant execute on function private.portal_transferir_inventario_impl(uuid,bigint),private.portal_receber_transferencia_impl(uuid,uuid) to authenticated;

create or replace function public.portal_transferir_inventario(p_item_id uuid,p_unidade_destino bigint) returns public.portal_transferencias_inventario language sql security invoker set search_path=public,private,pg_temp as $$ select private.portal_transferir_inventario_impl(p_item_id,p_unidade_destino) $$;
create or replace function public.portal_receber_transferencia(p_transferencia_id uuid,p_sala_id uuid) returns public.portal_inventario language sql security invoker set search_path=public,private,pg_temp as $$ select private.portal_receber_transferencia_impl(p_transferencia_id,p_sala_id) $$;
revoke all on function public.portal_transferir_inventario(uuid,bigint),public.portal_receber_transferencia(uuid,uuid) from public;
grant execute on function public.portal_transferir_inventario(uuid,bigint),public.portal_receber_transferencia(uuid,uuid) to authenticated;

do $$ begin alter publication supabase_realtime add table public.portal_transferencias_inventario; exception when duplicate_object then null; end $$;
commit;
