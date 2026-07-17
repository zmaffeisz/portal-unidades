# AGENTS.md — Portal Unidades

## Projeto

Frontend estático separado para coordenadores de unidades de saúde. Usa o mesmo Supabase do `dashboard-emendas`, mas não expõe telas de Emendas, Contratos, Licitações ou execução interna.

## Ambiente Supabase

- Único projeto permitido para execução e escrita: `qpvgpfwuurqcqprnpxua` (`contratos-dag`).
- Projeto legado `djtwoesmgeetnrztyvzw`: estritamente somente leitura.
- Nunca colocar chave `service_role` ou outra chave secreta no frontend.

## Segurança obrigatória

- Coordenadores só acessam linhas da UBS aprovada em `portal_unidades_acessos`.
- Escolher uma unidade no cadastro é apenas uma solicitação; não concede autorização.
- A aprovação do Portal não deve marcar `profiles.aprovado=true`, pois isso abriria o fluxo do sistema interno.
- RLS é autoritativa. Filtros no JavaScript são apenas apresentação.
- Administradores são reconhecidos pela regra existente `private.is_admin_approved()`.

## Estrutura

- `index.html` — login, cadastro e estrutura das telas.
- `styles.css` — identidade e layout responsivo.
- `js/config.js` — URL e chave pública do Supabase.
- `js/app.js` — autenticação, inventário, pedidos, consolidação e Realtime.
- `supabase/migrations/` — schema, gatilhos, grants e RLS do portal.

## Validação mínima

- `node --check js/app.js`
- Verificar todos os assets por servidor HTTP.
- Testar RLS como coordenador aprovado e administrador.
- Rodar advisors de segurança e desempenho após mudanças de schema.
