-- Índice de cobertura da FK composta sala/unidade.
-- Projeto Supabase autorizado: qpvgpfwuurqcqprnpxua (contratos-dag).

drop index if exists public.portal_pedidos_sala_idx;

create index if not exists portal_pedidos_sala_unidade_idx
  on public.portal_pedidos_itens (sala_id, unidade_id);
