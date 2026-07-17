# Changelog

## 2026-07-17

- Pedidos de compra novos agora exigem a seleção de uma sala ativa da própria unidade; pedidos anteriores permanecem identificados como sem sala até classificação manual.
- A sala do pedido passou a aparecer nas listas por unidade e nas exportações administrativas.
- Perfis aprovados definidos como **Divisão** no Dashboard agora administram o Portal Unidades com a mesma visão e as mesmas ações do administrador, sem receber o papel global de admin.
- A listagem de solicitações passou a expor aos gestores somente os dados mínimos necessários para a aprovação, por uma função protegida no banco.
- Administradores agora podem selecionar uma unidade no cabeçalho e atuar nela com as mesmas funções do coordenador.
- A visão por unidade permite cadastrar salas, incluir e atualizar inventário e manter pedidos de compra.
- A opção "Administração geral" retorna ao consolidado e às aprovações de acesso.
- Exportação administrativa em Excel com seleção de uma, várias ou todas as unidades.
- O arquivo exportado pode reunir inventário, pedidos de compra ou ambos, com resumo e abas por unidade.
- A exportação de pedidos começa por uma aba consolidada dos itens ativos, com as quantidades somadas e sem identificar as unidades.
- A segunda aba detalha os pedidos ativos por unidade; as abas individuais mantêm também o histórico de atendidos e cancelados.
- O detalhamento de pedidos por unidade agora começa recolhido: a administração vê as UBS e seus totais, expandindo cada uma apenas quando precisar consultar ou atender os itens.
- O inventário agora é exibido em cards expansíveis por sala, com quantidade total, itens, patrimônio, estado e ações preservadas.
- Os botões de adicionar inventário e pedido foram movidos para dentro dos cards de sala; ao abrir o formulário, a sala escolhida fica vinculada e bloqueada.
- O Consolidado administrativo agora tem sub-abas de Pedidos e Inventários; o inventário administrativo segue a hierarquia recolhível Unidade → Sala → Itens.
- O formulário de pedidos não exibe mais Categoria ou Especificação; sala, item, quantidade, unidade de medida, prioridade e justificativa são obrigatórios.

## 2026-07-16

- Primeira versão do Portal Unidades.
- Cadastro com escolha de UBS e aprovação administrativa separada do Dashboard de Emendas.
- Inventário por salas, com patrimônio, série, estado e quantidades.
- Lista permanente de pedidos de compra, com ajuste e cancelamento.
- Consolidação administrativa por item e detalhamento por unidade.
- Isolamento de dados por unidade com RLS e atualização em tempo real.
