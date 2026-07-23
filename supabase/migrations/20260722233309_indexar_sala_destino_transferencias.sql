create index if not exists portal_transferencias_sala_destino_idx
  on public.portal_transferencias_inventario(sala_destino_id,unidade_destino_id);
