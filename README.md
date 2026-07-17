# Portal Unidades

Portal separado para coordenadores das unidades de saúde, conectado ao mesmo Supabase do `dashboard-emendas`.

## Fluxos da primeira versão

- Cadastro com escolha da unidade e aprovação obrigatória por administrador.
- Coordenador vê somente a unidade aprovada.
- Inventário organizado por salas.
- Lista permanente de pedidos de compra, com inclusão, ajuste de quantidade e cancelamento.
- Administrador vê solicitações de acesso, pedidos consolidados e pedidos por unidade.
- Atualizações em tempo real via Supabase Realtime.

## Ambiente

- Frontend estático: HTML, CSS e JavaScript sem build.
- Backend: Supabase de produção `qpvgpfwuurqcqprnpxua` (`contratos-dag`).
- Hospedagem compatível com GitHub Pages.

## Execução local

```powershell
python -m http.server 8766
```

Abra `http://127.0.0.1:8766/index.html`.

## Banco

A migration em `supabase/migrations/` cria apenas as tabelas e políticas com prefixo `portal_`, além do gatilho de cadastro do portal em `auth.users`.
