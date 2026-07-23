const {createClient}=supabase;
const sb=createClient(PORTAL_CONFIG.supabaseUrl,PORTAL_CONFIG.supabaseKey);

const state={session:null,user:null,profile:null,access:null,isPortalManager:false,unitId:null,units:[],rooms:[],adminRooms:[],inventory:[],unserviceable:[],transfers:[],orders:[],adminOrders:[],adminInventory:[],consolidated:[],approvals:[],channel:null,tab:'overview',inventoryView:'active',inventoryAction:null,adminSubtab:'orders',exportUnitIds:new Set()};
const $=id=>document.getElementById(id);
const esc=v=>String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const fmtDate=v=>v?new Date(v).toLocaleDateString('pt-BR'):'—';
const unitName=id=>state.units.find(u=>String(u.id)===String(id))?.nome||'Unidade não identificada';
const roomName=(id,rooms=state.rooms)=>id?(rooms.find(r=>String(r.id)===String(id))?.nome||'Sala não encontrada'):'Sala não informada (pedido anterior)';
let toastTimer,reloadTimer;

function toast(message,type='ok'){
  const el=$('toast');el.textContent=message;el.className=`toast show ${type==='error'?'error':''}`;
  clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.className='toast',3500);
}
function setBusy(form,busy,label){const btn=form.querySelector('button[type="submit"]');if(!btn)return;if(!btn.dataset.label)btn.dataset.label=btn.textContent;btn.disabled=busy;btn.textContent=busy?label:btn.dataset.label;}
async function runWithTimeout(query,timeout=20000){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);try{return await query.abortSignal(controller.signal);}catch(error){return{error:{message:controller.signal.aborted?'A solicitação demorou demais. Verifique sua conexão e tente novamente.':error.message||'Não foi possível concluir a solicitação.'}};}finally{clearTimeout(timer);}}
function showOnly(id){['auth-screen','pending-screen','app-screen'].forEach(x=>$(x).hidden=x!==id);}
function openTab(name){
  state.tab=name;document.querySelectorAll('.tab-panel').forEach(p=>p.hidden=p.id!==`tab-${name}`);
  document.querySelectorAll('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.tab===name));
}
function toggleForm(id,force){const el=$(id),modal=$(`${id}-modal`);if(modal){const open=force===undefined?modal.hidden:Boolean(force);modal.hidden=!open;document.body.style.overflow=open?'hidden':'';if(open)setTimeout(()=>el.querySelector('input:not([disabled]),select:not([disabled]),textarea')?.focus(),0);return;}el.hidden=force===undefined?!el.hidden:!force;if(!el.hidden)el.querySelector('input,select,textarea')?.focus();}

async function loadUnits(){
  const {data,error}=await sb.from('unidades').select('id,nome').eq('ativo',true).order('nome');
  if(error){toast('Não foi possível carregar as unidades.','error');return;}
  state.units=data||[];
  const options='<option value="">Selecione sua unidade</option>'+state.units.map(u=>`<option value="${u.id}">${esc(u.nome)}</option>`).join('');
  $('register-unit').innerHTML=options;
  $('admin-unit-filter').innerHTML='<option value="">Todas as unidades</option>'+state.units.map(u=>`<option value="${u.id}">${esc(u.nome)}</option>`).join('');
  $('admin-unit-switch').innerHTML='<option value="">Administração geral</option>'+state.units.map(u=>`<option value="${u.id}">${esc(u.nome)}</option>`).join('');
  renderExportUnits();
}

async function routeSession(session){
  state.session=session;state.user=session?.user||null;
  if(!state.user){resetRealtime();showOnly('auth-screen');return;}
  const [{data:profile,error:pErr},{data:access,error:aErr}]=await Promise.all([
    sb.from('profiles').select('id,nome,email,papel,aprovado,escopo_organizacional').eq('id',state.user.id).maybeSingle(),
    sb.from('portal_unidades_acessos').select('*').eq('user_id',state.user.id).maybeSingle()
  ]);
  if(pErr||aErr){toast('Não foi possível conferir seu acesso.','error');return;}
  state.profile=profile;state.access=access;state.isPortalManager=profile?.aprovado===true&&(profile?.papel==='admin'||profile?.escopo_organizacional==='divisao');
  if(state.isPortalManager){state.unitId=null;await startAdmin();return;}
  if(!access||access.status!=='APROVADO'){
    showOnly('pending-screen');
    $('pending-title').textContent=access?.status==='REJEITADO'?'Acesso não aprovado':'Aguardando aprovação';
    $('pending-copy').textContent=access?.status==='REJEITADO'?(access.observacao_revisao||'Entre em contato com a administração para revisar sua solicitação.'):'Seu cadastro está aguardando a conferência do vínculo com a unidade.';
    $('pending-unit').textContent=unitName(access?.unidade_solicitada_id);
    subscribeRealtime();return;
  }
  state.unitId=access.unidade_id;await startCoordinator();
}

async function startCoordinator(){
  showOnly('app-screen');document.querySelectorAll('.coordinator-only').forEach(el=>el.hidden=false);document.querySelectorAll('.admin-only').forEach(el=>el.hidden=true);
  $('header-context').textContent=unitName(state.unitId);$('header-name').textContent=state.profile?.nome||state.user.email;$('header-role').textContent='Coordenador de unidade';
  $('welcome-title').textContent=`Olá, ${(state.profile?.nome||'coordenador').split(' ')[0]}!`;
  await loadCoordinatorData();openTab('inventory');subscribeRealtime();
}
async function startAdmin(){
  showOnly('app-screen');document.querySelectorAll('.coordinator-only').forEach(el=>el.hidden=true);document.querySelectorAll('.admin-only').forEach(el=>el.hidden=false);
  $('admin-unit-switch').value='';
  $('header-context').textContent='Visão de todas as unidades';$('header-name').textContent=state.profile?.nome||state.user.email;$('header-role').textContent=state.profile?.papel==='admin'?'Administrador':'Divisão — gestão do portal';
  $('welcome-title').textContent='Planejamento consolidado';
  await loadAdminData();openTab('admin');subscribeRealtime();
}
async function startAdminUnit(unitId){
  state.unitId=Number(unitId);showOnly('app-screen');document.querySelectorAll('.coordinator-only,.admin-only').forEach(el=>el.hidden=false);
  $('admin-unit-switch').value=String(state.unitId);$('header-context').textContent=unitName(state.unitId);$('header-name').textContent=state.profile?.nome||state.user.email;$('header-role').textContent=state.profile?.papel==='admin'?'Administrador atuando na unidade':'Divisão atuando na unidade';
  $('welcome-title').textContent=`Visão da ${unitName(state.unitId)}`;
  await loadCoordinatorData();openTab('inventory');subscribeRealtime();
}
async function switchAdminUnit(value){
  if(!state.isPortalManager)return;
  document.querySelectorAll('.inline-form').forEach(form=>form.hidden=true);
  if(!value){state.unitId=null;await startAdmin();return;}
  await startAdminUnit(value);
}

async function loadCoordinatorData(){
  const [rooms,inventory,unserviceable,transfers,orders]=await Promise.all([
    sb.from('portal_salas').select('*').eq('unidade_id',state.unitId).eq('ativo',true).order('nome'),
    sb.from('portal_inventario').select('*').eq('unidade_id',state.unitId).eq('ativo',true).order('item_nome'),
    sb.from('portal_inventario').select('*').eq('unidade_id',state.unitId).eq('ativo',false).eq('estado','INSERVIVEL').order('inservivel_em',{ascending:false}),
    sb.from('portal_transferencias_inventario').select('*').or(`unidade_origem_id.eq.${state.unitId},unidade_destino_id.eq.${state.unitId}`).order('enviado_em',{ascending:false}),
    sb.from('portal_pedidos_itens').select('*').eq('unidade_id',state.unitId).eq('status','ATIVO').order('atualizado_em',{ascending:false})
  ]);
  const error=rooms.error||inventory.error||unserviceable.error||transfers.error||orders.error;if(error){toast(error.message,'error');return;}
  state.rooms=rooms.data||[];state.inventory=inventory.data||[];state.unserviceable=unserviceable.data||[];state.transfers=transfers.data||[];state.orders=orders.data||[];
  renderCoordinator();
}
function renderCoordinator(){renderRoomOptions();renderMetrics();renderOverview();renderInventory();renderInventoryAux();renderOrders();}
function renderRoomOptions(){
  const opts=state.rooms.map(r=>`<option value="${r.id}">${esc(r.nome)}</option>`).join('');
  const inventoryRoom=$('inventory-room'),orderRoom=$('order-room'),inventoryValue=inventoryRoom.value,orderValue=orderRoom.value;
  inventoryRoom.innerHTML=state.rooms.length?'<option value="">Selecione</option>'+opts:'<option value="">Cadastre uma sala primeiro</option>';inventoryRoom.value=state.rooms.some(r=>String(r.id)===inventoryValue)?inventoryValue:'';
  orderRoom.innerHTML=state.rooms.length?'<option value="">Selecione a sala</option>'+opts:'<option value="">Cadastre uma sala primeiro</option>';orderRoom.value=state.rooms.some(r=>String(r.id)===orderValue)?orderValue:'';
  const current=$('inventory-room-filter').value;$('inventory-room-filter').innerHTML='<option value="">Todas as salas</option>'+opts;$('inventory-room-filter').value=current;
}
function renderMetrics(){
  const inventoryQty=state.inventory.length,orderQty=state.orders.reduce((s,i)=>s+Number(i.quantidade||0),0);
  $('metric-rooms').textContent=state.rooms.length;$('metric-inventory').textContent=state.inventory.length;$('metric-inventory-units').textContent=`${inventoryQty} unidades físicas`;$('metric-orders').textContent=state.orders.length;$('metric-order-units').textContent=`${orderQty} unidades solicitadas`;
}
function renderOverview(){
  $('overview-orders').innerHTML=state.orders.length?state.orders.slice(0,5).map(o=>`<div class="simple-row"><div><strong>${esc(o.item_nome)}</strong><small>${esc(o.categoria||'Sem categoria')} · ${esc(roomName(o.sala_id))}</small></div><b>${o.quantidade} ${esc(o.unidade_medida.toLowerCase())}</b></div>`).join(''):'Nenhum pedido ativo.';
  const counts=state.rooms.map(r=>({name:r.nome,count:state.inventory.filter(i=>i.sala_id===r.id).length}));const max=Math.max(1,...counts.map(x=>x.count));
  $('overview-rooms').innerHTML=counts.length?counts.map(x=>`<div class="bar-row"><span>${esc(x.name)}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.round(x.count/max*100)}%"></div></div><b>${x.count}</b></div>`).join(''):'Nenhuma sala cadastrada.';
}
function filteredInventory(){const room=$('inventory-room-filter').value,q=$('inventory-search').value.trim().toLowerCase();return state.inventory.filter(i=>(!room||i.sala_id===room)&&(!q||[i.item_nome,i.patrimonio,i.numero_serie,i.marca,i.modelo].join(' ').toLowerCase().includes(q)));}
function inventoryUnitRow(number){return`<div class="inventory-unit-row"><span class="inventory-unit-number">${number}</span><label><span>Patrimônio</span><input data-field="patrimonio" placeholder="Se houver"></label><label><span>Número de série</span><input data-field="numero_serie" placeholder="Se houver"></label><label><span>Marca</span><input data-field="marca"></label><label><span>Modelo</span><input data-field="modelo"></label><label><span>Estado</span><select data-field="estado"><option>NOVO</option><option selected>BOM</option><option>REGULAR</option><option>RUIM</option><option>INSERVIVEL</option></select></label><label><span>Observações</span><input data-field="observacoes" placeholder="Opcional"></label></div>`;}
function updateInventoryBatchTotal(){const total=$('inventory-batch-list').querySelectorAll('.inventory-unit-row').length;$('inventory-batch-total').textContent=`${total} ${total===1?'unidade física':'unidades físicas'}`;$('inventory-batch-list').querySelectorAll('[data-inventory-batch-remove]').forEach(button=>button.disabled=$('inventory-batch-list').children.length===1);}
function syncInventoryBatchGroup(group){const quantityInput=group.querySelector('.inventory-batch-quantity'),list=group.querySelector('.inventory-unit-list'),otherTotal=[...$('inventory-batch-list').querySelectorAll('.inventory-unit-list')].filter(other=>other!==list).reduce((sum,other)=>sum+other.children.length,0),requested=Math.max(1,Number.parseInt(quantityInput.value,10)||1),quantity=Math.min(100,200-otherTotal,requested);if(quantity<requested)toast('O limite é de 200 unidades físicas por envio.','error');quantityInput.value=quantity;while(list.children.length<quantity)list.insertAdjacentHTML('beforeend',inventoryUnitRow(list.children.length+1));while(list.children.length>quantity)list.lastElementChild.remove();[...list.children].forEach((row,index)=>row.querySelector('.inventory-unit-number').textContent=index+1);updateInventoryBatchTotal();}
function addInventoryBatchGroup(){if($('inventory-batch-list').querySelectorAll('.inventory-unit-row').length>=200){toast('O limite é de 200 unidades físicas por envio.','error');return null;}const group=document.createElement('article');group.className='inventory-batch-group';group.innerHTML=`<div class="inventory-batch-group-head"><label>Item<input class="inventory-batch-name" required placeholder="Ex.: Cadeira giratória"></label><label>Quantidade<input class="inventory-batch-quantity" type="number" min="1" max="100" value="1" required></label><button class="icon-btn" type="button" data-inventory-batch-remove>Remover item</button></div><div class="inventory-unit-scroll"><div class="inventory-unit-head"><span>#</span><span>Patrimônio</span><span>Número de série</span><span>Marca</span><span>Modelo</span><span>Estado</span><span>Observações</span></div><div class="inventory-unit-list"></div></div>`;$('inventory-batch-list').append(group);syncInventoryBatchGroup(group);return group;}
function resetInventoryBatch(){const list=$('inventory-batch-list');if(!list)return;list.innerHTML='';addInventoryBatchGroup();}
function openInventoryFormForRoom(roomId){resetInventoryBatch();const sel=$('inventory-room');sel.value=String(roomId);sel.disabled=true;toggleForm('inventory-form',true);setTimeout(()=>$('inventory-batch-list').querySelector('.inventory-batch-name')?.focus(),0);}
function updateOrderBatchTotal(){const rows=[...$('order-batch-list').querySelectorAll('.order-batch-row')],quantity=rows.reduce((sum,row)=>sum+(Number.parseInt(row.querySelector('.order-batch-quantity').value,10)||0),0);$('order-batch-total').textContent=`${rows.length} ${rows.length===1?'item':'itens'} · ${quantity} ${quantity===1?'unidade':'unidades'}`;rows.forEach(row=>row.querySelector('[data-order-batch-remove]').disabled=rows.length===1);}
function addOrderBatchItem(){const list=$('order-batch-list');if(list.children.length>=100){toast('O limite é de 100 tipos de item por envio.','error');return null;}const row=document.createElement('article');row.className='order-batch-row';row.dataset.requestId=crypto.randomUUID();row.innerHTML=`<label><span>Item desejado</span><input class="order-batch-name" required placeholder="Ex.: Cadeira fixa sem braço"></label><label><span>Quantidade</span><input class="order-batch-quantity" type="number" min="1" max="100000" value="1" required></label><label><span>Prioridade</span><select class="order-batch-priority" required><option>BAIXA</option><option selected>NORMAL</option><option>ALTA</option><option>URGENTE</option></select></label><label><span>Justificativa</span><textarea class="order-batch-justification" rows="2" required placeholder="Por que a unidade precisa deste item?"></textarea></label><button class="icon-btn" type="button" data-order-batch-remove>Remover</button>`;list.append(row);updateOrderBatchTotal();return row;}
function resetOrderBatch(){const list=$('order-batch-list');if(!list)return;list.innerHTML='';addOrderBatchItem();}
function openOrderFormForRoom(roomId){resetOrderBatch();const sel=$('order-room');sel.value=String(roomId);sel.disabled=true;toggleForm('order-form',true);setTimeout(()=>$('order-batch-list').querySelector('.order-batch-name')?.focus(),0);}

function filteredOrders(){const q=$('order-search').value.trim().toLowerCase();return state.orders.filter(o=>!q||[o.item_nome,o.categoria,o.especificacao,o.justificativa,roomName(o.sala_id)].join(' ').toLowerCase().includes(q));}
function renderInventory(){
  const rows=filteredInventory(),tableWrap=$('inventory-table')?.closest('.table-wrap');if(!tableWrap)return;
  tableWrap.hidden=true;let host=$('inventory-room-cards');if(!host){host=document.createElement('div');host.id='inventory-room-cards';tableWrap.after(host);}
  if(!rows.length){host.innerHTML='<div class="panel empty-state">Nenhum item encontrado.</div>';return;}
  const groups=new Map();rows.forEach(item=>{const key=String(item.sala_id||'sem-sala'),group=groups.get(key)||{nome:roomName(item.sala_id),items:[]};group.items.push(item);groups.set(key,group);});
  host.innerHTML=[...groups.values()].sort((a,b)=>a.nome.localeCompare(b.nome,'pt-BR')).map(group=>`<details class="inventory-room-card"><summary class="inventory-room-summary"><span><strong>${esc(group.nome)}</strong><small>${group.items.length} ${group.items.length===1?'item':'itens'} cadastrados</small></span><b>${group.items.length} unidades</b></summary><div class="inventory-room-body">${group.items.map(item=>`<div class="inventory-room-item"><div class="inventory-room-item-main"><strong>${esc(item.item_nome)}</strong><small>${esc([item.marca,item.modelo].filter(Boolean).join(' · ')||'Sem marca ou modelo')}</small>${item.patrimonio||item.numero_serie?`<p>${item.patrimonio?`Patrimônio: ${esc(item.patrimonio)}`:''}${item.patrimonio&&item.numero_serie?' · ':''}${item.numero_serie?`Série: ${esc(item.numero_serie)}`:''}</p>`:''}</div><span class="state-pill state-${esc(item.estado)}">${esc(item.estado)}</span><div class="inventory-room-actions"><button class="icon-btn" data-inventory-move="${item.id}">Mudar sala</button><button class="icon-btn" data-inventory-unserviceable="${item.id}">Inservível</button><button class="icon-btn" data-inventory-transfer="${item.id}">Transferir unidade</button><button class="icon-btn" data-inventory-remove="${item.id}">Retirar</button></div></div>`).join('')}</div></details>`).join('');
  host.querySelectorAll('.inventory-room-card').forEach(card=>{const roomNameText=card.querySelector('.inventory-room-summary strong')?.textContent||'',room=state.rooms.find(r=>r.nome===roomNameText);if(!room)return;card.querySelector('.inventory-room-body').insertAdjacentHTML('beforeend',`<div class="room-add-action"><button class="btn btn-secondary" data-inventory-add-room="${room.id}">+ Adicionar item nesta sala</button></div>`);});
}

function renderOrders(){
  const rows=filteredOrders(),qty=state.orders.reduce((s,o)=>s+Number(o.quantidade),0);$('cart-count').textContent=`${state.orders.length} ${state.orders.length===1?'item':'itens'}`;$('cart-total').textContent=`${qty} unidades solicitadas`;
  $('orders-list').innerHTML=rows.length?rows.map(o=>`<article class="cart-item"><div class="cart-item-head"><div><h3>${esc(o.item_nome)}</h3><p>${esc(o.categoria||'Sem categoria')}</p></div><span class="priority-pill priority-${o.prioridade}">${esc(o.prioridade)}</span></div><div class="cart-meta"><span class="status-pill">${esc(roomName(o.sala_id))}</span><span class="status-pill">${esc(o.unidade_medida)}</span>${o.especificacao?`<span class="status-pill">Com especificação</span>`:''}</div>${o.justificativa?`<p>${esc(o.justificativa)}</p>`:''}<div class="cart-footer"><div class="qty-control"><button data-order-qty="${o.id}" data-delta="-1">−</button><strong>${o.quantidade}</strong><button data-order-qty="${o.id}" data-delta="1">+</button></div><button class="text-button" data-order-cancel="${o.id}">Cancelar item</button></div></article>`).join(''):'<div class="panel empty-state">Sua lista de compras ainda está vazia.</div>';
}

function renderOrders(){
  const rows=filteredOrders(),qty=state.orders.reduce((s,o)=>s+Number(o.quantidade||0),0);
  $('cart-count').textContent=`${state.orders.length} ${state.orders.length===1?'item':'itens'}`;$('cart-total').textContent=`${qty} unidades solicitadas`;
  // Mesmo sem pedidos, as salas devem permanecer visíveis para iniciar a primeira solicitação.
  const summary=new Map();rows.forEach(o=>{const key=[String(o.item_nome||'').trim().toLowerCase(),String(o.unidade_medida||'')].join('|'),item=summary.get(key)||{nome:o.item_nome,unidade:o.unidade_medida,quantidade:0};item.quantidade+=Number(o.quantidade||0);summary.set(key,item);});
  const summaryHtml=[...summary.values()].sort((a,b)=>a.nome.localeCompare(b.nome,'pt-BR')).map(i=>`<div class="order-summary-row"><div><strong>${esc(i.nome)}</strong><small>${esc(i.unidade.toLowerCase())}</small></div><b>${i.quantidade} ${esc(i.unidade.toLowerCase())}</b></div>`).join('');
  const rooms=new Map(state.rooms.map(room=>[String(room.id),{nome:room.nome,items:[],quantidade:0}]));
  rows.forEach(o=>{const key=String(o.sala_id||'sem-sala'),group=rooms.get(key)||{nome:roomName(o.sala_id),items:[],quantidade:0};group.items.push(o);group.quantidade+=Number(o.quantidade||0);rooms.set(key,group);});
  const roomHtml=[...rooms.values()].sort((a,b)=>a.nome.localeCompare(b.nome,'pt-BR')).map(group=>`<details class="room-order-card"><summary class="room-order-summary"><span><strong>${esc(group.nome)}</strong><small>${group.items.length} ${group.items.length===1?'item':'itens'} aguardando pedido</small></span><b>${group.quantidade} unidades</b></summary><div class="room-order-body">${group.items.map(o=>`<div class="room-order-item"><div class="room-order-item-main"><strong>${esc(o.item_nome)}</strong><small>${esc(o.prioridade)} · ${esc(o.unidade_medida.toLowerCase())}</small>${o.justificativa?`<p>${esc(o.justificativa)}</p>`:''}</div><div class="room-order-item-actions"><div class="qty-control"><button data-order-qty="${o.id}" data-delta="-1">−</button><strong>${o.quantidade}</strong><button data-order-qty="${o.id}" data-delta="1">+</button></div><button class="text-button" data-order-cancel="${o.id}">Cancelar item</button></div></div>`).join('')}</div></details>`).join('');
  $('orders-list').innerHTML=`<section class="orders-summary"><div class="orders-summary-head"><div><p class="eyebrow">Resumo dos pedidos</p><h2>Todos os itens</h2></div><span>${summary.size} ${summary.size===1?'tipo de item':'tipos de itens'}</span></div><div class="orders-summary-grid">${summaryHtml}</div></section><div class="orders-by-room"><div class="orders-by-room-title"><p class="eyebrow">Detalhamento</p><h2>Pedidos por sala</h2></div>${roomHtml}</div>`;
  const summarySection=$('orders-list').querySelector('.orders-summary');
  if(summarySection){
    summarySection.outerHTML=`<details class="orders-summary"><summary class="orders-summary-collapsed"><span><strong>Resumo dos pedidos</strong><small>Quantidades somadas de todos os pedidos</small></span><b>Expandir</b></summary><div class="orders-summary-content">${summarySection.innerHTML}</div></details>`;
  }
  document.querySelectorAll('#orders-list .room-order-card').forEach(card=>{const roomNameText=card.querySelector('.room-order-summary strong')?.textContent||'',room=state.rooms.find(r=>r.nome===roomNameText);if(!room)return;card.querySelector('.room-order-body').insertAdjacentHTML('beforeend',`<div class="room-add-action"><button class="btn btn-secondary" data-order-add-room="${room.id}">+ Adicionar pedido nesta sala</button></div>`);});
}
function switchInventoryView(view){state.inventoryView=view;document.querySelectorAll('.inventory-subtab').forEach(button=>{const active=button.dataset.inventoryView===view;button.classList.toggle('active',active);button.setAttribute('aria-selected',String(active));});['active','unserviceable','transfers'].forEach(name=>$(`inventory-view-${name}`).hidden=name!==view);if(view!=='active')renderInventoryAux();}
function renderInventoryAux(){if(!$('unserviceable-list'))return;$('unserviceable-count').textContent=state.unserviceable.length;const incoming=state.transfers.filter(t=>String(t.unidade_destino_id)===String(state.unitId)),outgoing=state.transfers.filter(t=>String(t.unidade_origem_id)===String(state.unitId));$('transfer-count').textContent=incoming.filter(t=>t.status==='PENDENTE').length;$('unserviceable-list').innerHTML=state.unserviceable.length?state.unserviceable.map(item=>`<article class="inventory-history-item"><div><strong>${esc(item.item_nome)}</strong><small>${esc(roomName(item.sala_id))} · ${item.inservivel_em?fmtDate(item.inservivel_em):'Data não informada'}</small>${item.patrimonio||item.numero_serie?`<small>${item.patrimonio?`Patrimônio: ${esc(item.patrimonio)}`:''}${item.patrimonio&&item.numero_serie?' · ':''}${item.numero_serie?`Série: ${esc(item.numero_serie)}`:''}</small>`:''}</div><span class="state-pill state-INSERVIVEL">INSERVÍVEL</span></article>`).join(''):'<div class="panel empty-state">Nenhum item foi marcado como inservível.</div>';$('incoming-transfers').innerHTML=incoming.length?incoming.map(transferCard).join(''):'<div class="panel empty-state">Nenhuma transferência recebida ou pendente.</div>';$('outgoing-transfers').innerHTML=outgoing.length?outgoing.map(transferCard).join(''):'<div class="panel empty-state">Nenhum item enviado para outra unidade.</div>';}
function transferCard(t){const item=t.item||{},incoming=String(t.unidade_destino_id)===String(state.unitId),unit=incoming?unitName(t.unidade_origem_id):unitName(t.unidade_destino_id),pending=t.status==='PENDENTE';return`<article class="transfer-card"><div class="transfer-card-main"><strong>${esc(item.item_nome||'Item sem nome')}</strong><small>${incoming?'Origem':'Destino'}: ${esc(unit)}</small><div class="transfer-card-meta"><span class="status-pill">${esc(t.status)}</span>${item.patrimonio?`<span class="status-pill">Patrimônio ${esc(item.patrimonio)}</span>`:''}<span class="status-pill">Enviado em ${fmtDate(t.enviado_em)}</span></div></div><div class="transfer-card-actions">${incoming&&pending?`<button class="btn btn-primary" data-transfer-receive="${t.id}">Receber item</button>`:pending?'<span class="muted">Aguardando recebimento</span>':`<span class="state-pill state-BOM">Recebido em ${fmtDate(t.recebido_em)}</span>`}</div></article>`;}

async function loadAdminData(){
  const [accesses,rooms,orders,inventory,consolidated]=await Promise.all([
    sb.rpc('portal_listar_solicitacoes_acesso'),
    sb.from('portal_salas').select('id,unidade_id,nome').eq('ativo',true).order('nome'),
    sb.from('portal_pedidos_itens').select('*').eq('status','ATIVO').order('unidade_id'),
    sb.from('portal_inventario').select('*').eq('ativo',true).order('unidade_id'),
    sb.from('portal_pedidos_consolidados').select('*').order('quantidade_total',{ascending:false})
  ]);
  const error=accesses.error||rooms.error||orders.error||inventory.error||consolidated.error;if(error){toast(error.message,'error');return;}
  state.approvals=accesses.data||[];state.adminRooms=rooms.data||[];state.adminOrders=orders.data||[];state.adminInventory=inventory.data||[];state.consolidated=consolidated.data||[];
  renderAdmin();
}
function switchAdminSubtab(name){state.adminSubtab=name;document.querySelectorAll('.admin-subtab').forEach(b=>{const active=b.dataset.adminSubtab===name;b.classList.toggle('active',active);b.setAttribute('aria-selected',String(active));});document.querySelectorAll('#tab-admin > .page-heading,#tab-admin > .admin-orders-summary,#tab-admin > .toolbar,#tab-admin > .table-wrap,#tab-admin > .section-title,#admin-orders-by-unit').forEach(el=>{el.hidden=name!=='orders';});$('admin-subtab-inventory').hidden=name!=='inventory';if(name==='inventory')renderAdminInventory();}
function renderAdminInventory(){const q=$('admin-inventory-search')?.value.trim().toLowerCase()||'',items=state.adminInventory.filter(i=>!q||[i.item_nome,i.patrimonio,i.numero_serie,i.marca,i.modelo,roomName(i.sala_id,state.adminRooms),unitName(i.unidade_id)].join(' ').toLowerCase().includes(q));$('admin-inventory-by-unit').innerHTML=state.units.map(unit=>{const unitItems=items.filter(i=>String(i.unidade_id)===String(unit.id)),rooms=new Map();unitItems.forEach(i=>{const key=String(i.sala_id||'sem-sala'),room=rooms.get(key)||{nome:roomName(i.sala_id,state.adminRooms),items:[],quantidade:0};room.items.push(i);room.quantidade+=Number(i.quantidade||0);rooms.set(key,room);});const total=unitItems.reduce((s,i)=>s+Number(i.quantidade||0),0);return`<details class="admin-inventory-unit"><summary class="admin-inventory-unit-summary"><span><strong>${esc(unit.nome)}</strong><small>${unitItems.length} ${unitItems.length===1?'item':'itens'} cadastrados</small></span><b>${total} unidades</b></summary><div class="admin-inventory-unit-body">${rooms.size?[...rooms.values()].sort((a,b)=>a.nome.localeCompare(b.nome,'pt-BR')).map(room=>`<details class="admin-inventory-room"><summary class="admin-inventory-room-summary"><span><strong>${esc(room.nome)}</strong><small>${room.items.length} ${room.items.length===1?'item':'itens'}</small></span><b>${room.quantidade} unidades</b></summary><div class="admin-inventory-room-body">${room.items.map(i=>`<div class="admin-inventory-item"><div><strong>${esc(i.item_nome)}</strong><small>${esc([i.marca,i.modelo].filter(Boolean).join(' · ')||'Sem marca ou modelo')}</small>${i.patrimonio||i.numero_serie?`<p>${i.patrimonio?`Patrimônio: ${esc(i.patrimonio)}`:''}${i.patrimonio&&i.numero_serie?' · ':''}${i.numero_serie?`Série: ${esc(i.numero_serie)}`:''}</p>`:''}</div><span class="state-pill state-${esc(i.estado)}">${esc(i.estado)}</span><b>${i.quantidade}</b></div>`).join('')}</div></details>`).join(''):'<div class="admin-inventory-empty">Nenhum item cadastrado.</div>'}</div></details>`;}).join('');}
function renderAdmin(){renderAdminOverview();renderAdminInventory();renderApprovals();switchAdminSubtab(state.adminSubtab);}
function renderAdminOverview(){
  const q=$('admin-search').value.trim().toLowerCase(),unit=$('admin-unit-filter').value;
  let cons=state.consolidated;if(q)cons=cons.filter(i=>[i.item_nome,i.categoria].join(' ').toLowerCase().includes(q));
  $('consolidated-table').innerHTML=cons.length?cons.map(i=>`<tr><td><strong>${esc(i.item_nome)}</strong></td><td>${esc(i.categoria||'—')}</td><td><strong>${i.quantidade_total} ${esc(i.unidade_medida.toLowerCase())}</strong></td><td>${i.total_unidades}</td><td>${fmtDate(i.atualizado_em)}</td></tr>`).join(''):'<tr><td colspan="5" class="empty-state">Nenhum pedido ativo.</td></tr>';
  const orders=state.adminOrders.filter(o=>!unit||String(o.unidade_id)===unit);const groups={};orders.forEach(o=>(groups[o.unidade_id]??=[]).push(o));
  $('admin-orders-by-unit').innerHTML=Object.keys(groups).length?Object.entries(groups).sort((a,b)=>unitName(a[0]).localeCompare(unitName(b[0]),'pt-BR')).map(([id,items])=>`<article class="unit-group"><div class="unit-group-head"><strong>${esc(unitName(id))}</strong><span>${items.length} ${items.length===1?'item':'itens'} · ${items.reduce((s,i)=>s+Number(i.quantidade),0)} unidades</span></div><div class="unit-group-body">${items.map(i=>`<div class="simple-row"><div><strong>${esc(i.item_nome)}</strong><small>${esc(i.categoria||'Sem categoria')} · ${esc(i.prioridade)} · ${esc(roomName(i.sala_id,state.adminRooms))}</small></div><div><b>${i.quantidade} ${esc(i.unidade_medida.toLowerCase())}</b> <button class="icon-btn" data-order-attend="${i.id}">Marcar atendido</button></div></div>`).join('')}</div></article>`).join(''):'<div class="panel empty-state">Nenhum pedido para o filtro selecionado.</div>';
  if(!state.unitId){$('metric-rooms').textContent='—';$('metric-inventory').textContent='—';$('metric-orders').textContent=state.adminOrders.length;$('metric-order-units').textContent=`${state.adminOrders.reduce((s,i)=>s+Number(i.quantidade),0)} unidades solicitadas`;$('overview-orders').innerHTML='Use a aba Consolidado para acompanhar todas as unidades.';$('overview-rooms').innerHTML='Visão administrativa ativa.';}
}
function renderApprovals(){
  document.querySelectorAll('#admin-orders-by-unit .unit-group').forEach(group=>{const body=group.querySelector('.unit-group-body'),head=group.querySelector('.unit-group-head');if(!body||!head)return;body.hidden=true;head.setAttribute('role','button');head.setAttribute('tabindex','0');const toggle=()=>{body.hidden=!body.hidden;group.classList.toggle('expanded',!body.hidden);};head.onclick=toggle;head.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();toggle();}};});
  const pending=state.approvals.filter(a=>a.status==='PENDENTE');$('approval-badge').textContent=pending.length;
  $('approvals-list').innerHTML=state.approvals.length?state.approvals.map(a=>`<article class="approval-card"><div><h3>${esc(a.nome||'Usuário')}</h3><p>${esc(a.email||'E-mail não disponível')} · solicitado em ${fmtDate(a.solicitado_em)}</p></div><div><span class="status-pill">${esc(unitName(a.unidade_solicitada_id))}</span><p>Status: ${esc(a.status)}</p></div><div class="approval-actions">${a.status==='PENDENTE'?`<button class="btn btn-primary" data-approve="${a.user_id}">Aprovar</button><button class="btn btn-danger" data-reject="${a.user_id}">Rejeitar</button>`:`<span class="state-pill ${a.status==='APROVADO'?'state-BOM':'state-RUIM'}">${esc(a.status)}</span>`}</div></article>`).join(''):'<div class="panel empty-state">Nenhuma solicitação de acesso.</div>';
}

function updateExportSelectedCount(){
  const total=state.exportUnitIds.size;$('export-selected-count').textContent=`${total} ${total===1?'selecionada':'selecionadas'}`;
}
function renderExportUnits(){
  const list=$('export-unit-list');if(!list)return;const q=$('export-unit-search')?.value.trim().toLowerCase()||'';
  const units=state.units.filter(u=>!q||u.nome.toLowerCase().includes(q));
  list.innerHTML=units.length?units.map(u=>`<label class="export-unit-option"><input type="checkbox" value="${u.id}" ${state.exportUnitIds.has(String(u.id))?'checked':''}><span>${esc(u.nome)}</span></label>`).join(''):'<div class="empty-state">Nenhuma unidade encontrada.</div>';
  updateExportSelectedCount();
}
function openExportModal(){
  if(!state.isPortalManager)return;if(!state.exportUnitIds.size&&state.unitId)state.exportUnitIds.add(String(state.unitId));
  $('export-unit-search').value='';renderExportUnits();$('export-modal').hidden=false;document.body.style.overflow='hidden';setTimeout(()=>$('export-unit-search').focus(),0);
}
function closeExportModal(){$('export-modal').hidden=true;document.body.style.overflow='';}
async function fetchExportRows(table,columns,unitIds,{activeOnly=false,sortField='item_nome'}={}){
  const pageSize=1000,rows=[];let from=0;
  while(true){
    let query=sb.from(table).select(columns).in('unidade_id',unitIds).order('unidade_id',{ascending:true}).order(sortField,{ascending:true}).range(from,from+pageSize-1);
    if(activeOnly)query=query.eq('ativo',true);
    const {data,error}=await query;if(error)throw error;rows.push(...(data||[]));if(!data||data.length<pageSize)break;from+=pageSize;
  }
  return rows;
}
function exportDate(value){return value?new Date(value):null;}
function uniqueSheetName(prefix,unitNameValue,used){
  const shortName=unitNameValue.replace(/^UBS\s+/i,'').replace(/[\\/?*\[\]:]/g,' ').replace(/\s+/g,' ').trim();let base=`${prefix} ${shortName}`.slice(0,31).trim(),name=base,n=2;
  while(used.has(name)){const suffix=` ${n++}`;name=(base.slice(0,31-suffix.length)+suffix).trim();}used.add(name);return name;
}
function makeDataSheet(rows,headers,widths,dateHeaders=[]){
  const ws=XLSX.utils.json_to_sheet(rows,{header:headers,cellDates:true,dateNF:'dd/mm/yyyy hh:mm'});ws['!cols']=widths.map(wch=>({wch}));
  if(headers.length)ws['!autofilter']={ref:XLSX.utils.encode_range({s:{r:0,c:0},e:{r:Math.max(rows.length,1),c:headers.length-1}})};
  dateHeaders.forEach(header=>{const col=headers.indexOf(header);if(col<0)return;for(let row=1;row<=rows.length;row++){const cell=ws[XLSX.utils.encode_cell({r:row,c:col})];if(cell)cell.z='dd/mm/yyyy hh:mm';}});
  return ws;
}
function makeSummarySheet(selectedUnits,rooms,inventory,orders,includeInventory,includeOrders){
  const summary=selectedUnits.map(unit=>{const unitRooms=rooms.filter(r=>String(r.unidade_id)===String(unit.id)),unitInventory=inventory.filter(i=>String(i.unidade_id)===String(unit.id)),unitOrders=orders.filter(o=>String(o.unidade_id)===String(unit.id)),activeOrders=unitOrders.filter(o=>o.status==='ATIVO');return{
    'Unidade':unit.nome,
    'Salas cadastradas':includeInventory?unitRooms.length:'—',
    'Itens no inventário':includeInventory?unitInventory.length:'—',
    'Unidades físicas':includeInventory?unitInventory.reduce((sum,item)=>sum+Number(item.quantidade||0),0):'—',
    'Pedidos totais':includeOrders?unitOrders.length:'—',
    'Pedidos ativos':includeOrders?activeOrders.length:'—',
    'Unidades solicitadas ativas':includeOrders?activeOrders.reduce((sum,item)=>sum+Number(item.quantidade||0),0):'—',
    'Pedidos atendidos':includeOrders?unitOrders.filter(o=>o.status==='ATENDIDO').length:'—',
    'Pedidos cancelados':includeOrders?unitOrders.filter(o=>o.status==='CANCELADO').length:'—'
  }});
  const headers=Object.keys(summary[0]||{'Unidade':''}),ws=XLSX.utils.aoa_to_sheet([
    ['PORTAL UNIDADES — EXPORTAÇÃO ADMINISTRATIVA'],
    ['Gerado em',new Date()],
    ['Conteúdo',[includeInventory?'Inventário':null,includeOrders?'Pedidos de compra':null].filter(Boolean).join(' e ')],
    ['Unidades selecionadas',selectedUnits.length]
  ],{cellDates:true,dateNF:'dd/mm/yyyy hh:mm'});
  ws['!merges']=[XLSX.utils.decode_range(`A1:${XLSX.utils.encode_col(Math.max(headers.length-1,0))}1`)];XLSX.utils.sheet_add_json(ws,summary,{origin:'A6',header:headers,skipHeader:false,cellDates:true,dateNF:'dd/mm/yyyy hh:mm'});
  ws['!cols']=[{wch:34},{wch:18},{wch:20},{wch:18},{wch:17},{wch:16},{wch:28},{wch:20},{wch:21}];ws['!rows']=[{hpt:24}];ws['!autofilter']={ref:`A6:${XLSX.utils.encode_col(headers.length-1)}${summary.length+6}`};if(ws.B2)ws.B2.z='dd/mm/yyyy hh:mm';return ws;
}
function normalizeOrderValue(value){return String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().replace(/\s+/g,' ').toLocaleLowerCase('pt-BR');}
function makeConsolidatedOrdersSheet(orders){
  const priorityRank={BAIXA:1,NORMAL:2,ALTA:3,URGENTE:4},groups=new Map();
  orders.filter(order=>order.status==='ATIVO').forEach(order=>{
    const key=[order.item_nome,order.categoria,order.unidade_medida].map(normalizeOrderValue).join('|'),current=groups.get(key);
    if(current){current.quantidade+=Number(order.quantidade||0);if((priorityRank[order.prioridade]||0)>(priorityRank[current.prioridade]||0))current.prioridade=order.prioridade;return;}
    groups.set(key,{item:order.item_nome,categoria:order.categoria||'',quantidade:Number(order.quantidade||0),unidadeMedida:order.unidade_medida||'',prioridade:order.prioridade||''});
  });
  const rows=[...groups.values()].sort((a,b)=>a.item.localeCompare(b.item,'pt-BR')).map(group=>({
    'Item':group.item,'Categoria':group.categoria,'Quantidade total':group.quantidade,'Unidade de medida':group.unidadeMedida,'Maior prioridade':group.prioridade
  }));
  return makeDataSheet(rows,['Item','Categoria','Quantidade total','Unidade de medida','Maior prioridade'],[36,24,18,20,18]);
}
function makeOrdersByUnitSheet(selectedUnits,orders,roomNames){
  const unitsById=new Map(selectedUnits.map(unit=>[String(unit.id),unit.nome]));
  const rows=orders.filter(order=>order.status==='ATIVO').map(order=>({
    'Unidade':unitsById.get(String(order.unidade_id))||'Unidade não identificada','Sala':roomNames.get(order.sala_id)||'Não informada (pedido anterior)','Item':order.item_nome,'Categoria':order.categoria||'','Quantidade':Number(order.quantidade||0),'Unidade de medida':order.unidade_medida||'','Prioridade':order.prioridade||'','Especificação':order.especificacao||'','Justificativa':order.justificativa||'','Solicitado em':exportDate(order.criado_em),'Atualizado em':exportDate(order.atualizado_em)
  })).sort((a,b)=>a.Unidade.localeCompare(b.Unidade,'pt-BR')||a.Item.localeCompare(b.Item,'pt-BR'));
  return makeDataSheet(rows,['Unidade','Sala','Item','Categoria','Quantidade','Unidade de medida','Prioridade','Especificação','Justificativa','Solicitado em','Atualizado em'],[30,24,36,22,14,20,16,48,48,20,20],['Solicitado em','Atualizado em']);
}
async function downloadAdminExport(){
  if(!state.isPortalManager)return toast('Somente gestores do Portal Unidades podem exportar os dados.','error');
  const unitIds=[...state.exportUnitIds].map(Number),includeInventory=$('export-inventory').checked,includeOrders=$('export-orders').checked;
  if(!unitIds.length)return toast('Selecione pelo menos uma unidade.','error');if(!includeInventory&&!includeOrders)return toast('Escolha inventário, pedidos de compra ou ambos.','error');if(!window.XLSX)return toast('O gerador de Excel não foi carregado. Atualize a página e tente novamente.','error');
  const button=$('download-export'),original=button.textContent;button.disabled=true;button.textContent='Preparando arquivo...';
  try{
    const [rooms,inventory,orders]=await Promise.all([
      includeInventory||includeOrders?fetchExportRows('portal_salas','id,unidade_id,nome,descricao,criado_em,atualizado_em',unitIds,{sortField:'nome'}):[],
      includeInventory?fetchExportRows('portal_inventario','id,unidade_id,sala_id,item_nome,categoria,quantidade,patrimonio,numero_serie,marca,modelo,estado,observacoes,criado_em,atualizado_em',unitIds,{activeOnly:true}):[],
      includeOrders?fetchExportRows('portal_pedidos_itens','id,unidade_id,sala_id,item_nome,categoria,quantidade,unidade_medida,especificacao,justificativa,prioridade,status,criado_em,atualizado_em,cancelado_em,atendido_em',unitIds):[]
    ]);
    const selectedUnits=state.units.filter(u=>state.exportUnitIds.has(String(u.id))).sort((a,b)=>a.nome.localeCompare(b.nome,'pt-BR')),roomNames=new Map(rooms.map(r=>[r.id,r.nome])),wb=XLSX.utils.book_new(),usedNames=new Set();
    wb.Props={Title:'Portal Unidades — Inventários e pedidos de compra',Subject:'Exportação administrativa por unidade',Author:state.profile?.nome||'Portal Unidades',CreatedDate:new Date()};
    if(includeOrders){XLSX.utils.book_append_sheet(wb,makeConsolidatedOrdersSheet(orders),'Pedidos consolidados');usedNames.add('Pedidos consolidados');XLSX.utils.book_append_sheet(wb,makeOrdersByUnitSheet(selectedUnits,orders,roomNames),'Pedidos por unidade');usedNames.add('Pedidos por unidade');}
    XLSX.utils.book_append_sheet(wb,makeSummarySheet(selectedUnits,rooms,inventory,orders,includeInventory,includeOrders),'Resumo');usedNames.add('Resumo');
    for(const unit of selectedUnits){
      if(includeInventory){const rows=inventory.filter(i=>String(i.unidade_id)===String(unit.id)).map(i=>({'Unidade':unit.nome,'Sala':roomNames.get(i.sala_id)||'Não identificada','Item':i.item_nome,'Categoria':i.categoria||'','Quantidade':Number(i.quantidade||0),'Patrimônio':i.patrimonio||'','Número de série':i.numero_serie||'','Marca':i.marca||'','Modelo':i.modelo||'','Estado':i.estado,'Observações':i.observacoes||'','Cadastrado em':exportDate(i.criado_em),'Atualizado em':exportDate(i.atualizado_em)})),headers=['Unidade','Sala','Item','Categoria','Quantidade','Patrimônio','Número de série','Marca','Modelo','Estado','Observações','Cadastrado em','Atualizado em'];XLSX.utils.book_append_sheet(wb,makeDataSheet(rows,headers,[28,24,30,20,12,18,20,18,20,14,42,20,20],['Cadastrado em','Atualizado em']),uniqueSheetName('INV',unit.nome,usedNames));}
      if(includeOrders){const rows=orders.filter(o=>String(o.unidade_id)===String(unit.id)).map(o=>({'Unidade':unit.nome,'Sala':roomNames.get(o.sala_id)||'Não informada (pedido anterior)','Item':o.item_nome,'Categoria':o.categoria||'','Quantidade':Number(o.quantidade||0),'Unidade de medida':o.unidade_medida,'Prioridade':o.prioridade,'Status':o.status,'Especificação':o.especificacao||'','Justificativa':o.justificativa||'','Solicitado em':exportDate(o.criado_em),'Atualizado em':exportDate(o.atualizado_em),'Cancelado em':exportDate(o.cancelado_em),'Atendido em':exportDate(o.atendido_em)})),headers=['Unidade','Sala','Item','Categoria','Quantidade','Unidade de medida','Prioridade','Status','Especificação','Justificativa','Solicitado em','Atualizado em','Cancelado em','Atendido em'];XLSX.utils.book_append_sheet(wb,makeDataSheet(rows,headers,[28,24,32,20,12,18,14,14,48,48,20,20,20,20],['Solicitado em','Atualizado em','Cancelado em','Atendido em']),uniqueSheetName('PED',unit.nome,usedNames));}
    }
    const now=new Date(),stamp=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;XLSX.writeFile(wb,`portal-unidades_${stamp}.xlsx`,{compression:true,cellDates:true});toast('Arquivo Excel gerado com sucesso.');closeExportModal();
  }catch(error){console.error(error);toast(`Não foi possível gerar o arquivo: ${error.message||'erro inesperado'}`,'error');}
  finally{button.disabled=false;button.textContent=original;}
}

async function submitRoom(e){e.preventDefault();setBusy(e.currentTarget,true,'Salvando...');const {error}=await sb.from('portal_salas').insert({unidade_id:state.unitId,nome:$('room-name').value.trim(),descricao:$('room-description').value.trim()||null,criado_por:state.user.id});setBusy(e.currentTarget,false);if(error)return toast(error.message,'error');e.currentTarget.reset();toggleForm('room-form',false);toast('Sala cadastrada.');await loadCoordinatorData();}
async function submitInventory(e){e.preventDefault();if(!state.rooms.length)return toast('Cadastre uma sala primeiro.','error');const form=e.currentTarget,room=$('inventory-room').value,groups=[...$('inventory-batch-list').querySelectorAll('.inventory-batch-group')],payload=[];if(!room)return toast('Selecione a sala.','error');for(const group of groups){const name=group.querySelector('.inventory-batch-name').value.trim();if(!name)return toast('Informe o nome de todos os itens.','error');for(const row of group.querySelectorAll('.inventory-unit-row')){const value=field=>row.querySelector(`[data-field="${field}"]`).value.trim();payload.push({unidade_id:state.unitId,sala_id:room,item_nome:name,categoria:null,quantidade:1,patrimonio:value('patrimonio')||null,numero_serie:value('numero_serie')||null,marca:value('marca')||null,modelo:value('modelo')||null,estado:value('estado'),observacoes:value('observacoes')||null,criado_por:state.user.id,atualizado_por:state.user.id});}}if(!payload.length)return toast('Adicione pelo menos um item.','error');if(payload.length>200)return toast('O limite é de 200 unidades físicas por envio.','error');setBusy(form,true,'Salvando lista...');try{const {error}=await runWithTimeout(sb.from('portal_inventario').insert(payload),30000);if(error)return toast(error.message,'error');form.reset();resetInventoryBatch();$('inventory-room').disabled=false;toggleForm('inventory-form',false);toast(`${payload.length} ${payload.length===1?'item incluído':'itens incluídos'} no inventário.`);await loadCoordinatorData();}catch(error){toast(error.message||'Não foi possível salvar a lista de itens.','error');}finally{setBusy(form,false);}}
async function changeOrderQty(id,delta){const row=state.orders.find(x=>x.id===id);if(!row)return;try{const {data,error}=await sb.rpc('portal_alterar_quantidade_pedido',{p_pedido_id:id,p_delta:Number(delta)}).single();if(error)return toast(error.message,'error');state.orders=state.orders.map(item=>item.id===id?data:item);renderCoordinator();}catch(error){toast(error.message||'Não foi possível ajustar a quantidade.','error');}}
function openInventoryAction(mode,id){const item=state.inventory.find(row=>row.id===id)||(state.transfers.find(row=>row.id===id)?.item||{}),select=$('inventory-action-select'),label=$('inventory-action-select-label'),labelText=$('inventory-action-select-text'),warning=$('inventory-action-warning');state.inventoryAction={mode,id};$('inventory-action-copy').textContent=item?.item_nome||'Item do inventário';warning.className='';label.hidden=false;if(mode==='move'){$('inventory-action-title').textContent='Mudar item de sala';$('inventory-action-eyebrow').textContent='Movimentação interna';labelText.textContent='Nova sala';select.innerHTML='<option value="">Selecione a sala</option>'+state.rooms.filter(room=>String(room.id)!==String(item.sala_id)).map(room=>`<option value="${room.id}">${esc(room.nome)}</option>`).join('');warning.textContent=select.options.length===1?'Cadastre outra sala antes de mover este item.':'O item continuará na mesma unidade.';}else if(mode==='transfer'){$('inventory-action-title').textContent='Transferir para outra unidade';$('inventory-action-eyebrow').textContent='Transferência de patrimônio';labelText.textContent='Unidade de destino';select.innerHTML='<option value="">Selecione a unidade</option>'+state.units.filter(unit=>String(unit.id)!==String(state.unitId)).map(unit=>`<option value="${unit.id}">${esc(unit.nome)}</option>`).join('');warning.textContent=select.options.length===1?'Nenhuma outra unidade ativa está disponível.':'O item sairá do inventário atual e só entrará no destino após o recebimento.';}else if(mode==='receive'){$('inventory-action-title').textContent='Receber item transferido';$('inventory-action-eyebrow').textContent='Entrada de patrimônio';labelText.textContent='Sala onde o item ficará';select.innerHTML='<option value="">Selecione a sala</option>'+state.rooms.map(room=>`<option value="${room.id}">${esc(room.nome)}</option>`).join('');warning.textContent=state.rooms.length?'Ao confirmar, o item entrará no inventário desta unidade.':'Cadastre uma sala antes de receber o item.';}else{$('inventory-action-title').textContent='Marcar como inservível';$('inventory-action-eyebrow').textContent='Baixa do inventário ativo';label.hidden=true;select.innerHTML='<option value="confirmado" selected>Confirmado</option>';warning.textContent='Esta ação removerá o item do inventário ativo e o colocará na aba Inservíveis.';warning.className='danger-copy';}$('inventory-action-modal').hidden=false;document.body.style.overflow='hidden';if(!label.hidden)setTimeout(()=>select.focus(),0);}
function closeInventoryAction(){state.inventoryAction=null;$('inventory-action-modal').hidden=true;document.body.style.overflow='';$('inventory-action-form').reset();}
async function submitInventoryAction(e){e.preventDefault();const action=state.inventoryAction;if(!action)return;const value=$('inventory-action-select').value,button=$('confirm-inventory-action');if(action.mode!=='unserviceable'&&!value)return toast('Selecione um destino.','error');button.disabled=true;button.textContent='Processando...';try{let request;if(action.mode==='move')request=sb.rpc('portal_mover_inventario_sala',{p_item_id:action.id,p_sala_id:value});else if(action.mode==='transfer')request=sb.rpc('portal_transferir_inventario',{p_item_id:action.id,p_unidade_destino:Number(value)});else if(action.mode==='receive')request=sb.rpc('portal_receber_transferencia',{p_transferencia_id:action.id,p_sala_id:value});else request=sb.rpc('portal_marcar_inventario_inservivel',{p_item_id:action.id});const {error}=await runWithTimeout(request);if(error)return toast(error.message,'error');const messages={move:'Item movido de sala.',transfer:'Transferência enviada para a unidade de destino.',receive:'Item recebido e incluído no inventário.',unserviceable:'Item movido para a aba Inservíveis.'};toast(messages[action.mode]);closeInventoryAction();await loadCoordinatorData();}catch(error){toast(error.message||'Não foi possível concluir a movimentação.','error');}finally{button.disabled=false;button.textContent='Confirmar';}}
async function updateItem(table,id,patch,message){const {error}=await sb.from(table).update(patch).eq('id',id);if(error)return toast(error.message,'error');toast(message);state.isPortalManager&&!state.unitId?await loadAdminData():await loadCoordinatorData();}
async function submitOrder(e){e.preventDefault();if(!state.rooms.length)return toast('Cadastre uma sala antes de solicitar um item.','error');const form=e.currentTarget,room=$('order-room').value,rows=[...$('order-batch-list').querySelectorAll('.order-batch-row')];if(!room)return toast('Selecione a sala.','error');const items=[];for(const row of rows){const item_nome=row.querySelector('.order-batch-name').value.trim(),quantidade=Number.parseInt(row.querySelector('.order-batch-quantity').value,10),prioridade=row.querySelector('.order-batch-priority').value,justificativa=row.querySelector('.order-batch-justification').value.trim();if(!item_nome||!Number.isFinite(quantidade)||quantidade<1||!prioridade||!justificativa)return toast('Preencha item, quantidade, prioridade e justificativa em todas as linhas.','error');items.push({client_request_id:row.dataset.requestId,item_nome,quantidade,prioridade,justificativa});}if(!items.length)return toast('Adicione pelo menos um pedido.','error');setBusy(form,true,'Salvando lista...');try{const {error}=await runWithTimeout(sb.rpc('portal_criar_pedidos_lote',{p_sala_id:room,p_itens:items}),30000);if(error)return toast(error.message,'error');form.reset();resetOrderBatch();$('order-room').disabled=false;toggleForm('order-form',false);toast(`${items.length} ${items.length===1?'pedido adicionado':'pedidos adicionados'} à lista de compras.`);await loadCoordinatorData();}catch(error){toast(error.message||'Não foi possível concluir os pedidos.','error');}finally{setBusy(form,false);}}
async function reviewAccess(id,status){
  const row=state.approvals.find(a=>a.user_id===id);if(!row)return;
  const {error}=await sb.from('portal_unidades_acessos').update({status,unidade_id:status==='APROVADO'?row.unidade_solicitada_id:null}).eq('user_id',id);
  if(error)return toast(error.message,'error');
  toast(status==='APROVADO'?'Acesso aprovado.':'Solicitação rejeitada.');await loadAdminData();
}

function resetRealtime(){if(state.channel){sb.removeChannel(state.channel);state.channel=null;}}
function applyCoordinatorChange(payload){if(payload.table==='portal_inventario'||payload.table==='portal_transferencias_inventario')return scheduleReload();const lists={portal_salas:'rooms',portal_pedidos_itens:'orders'},key=lists[payload.table];if(!key)return scheduleReload();const row=payload.new?.id?payload.new:payload.old;if(!row?.id)return scheduleReload();const visible=key==='rooms'?row.ativo!==false:row.status==='ATIVO',current=state[key],index=current.findIndex(item=>item.id===row.id);if(payload.eventType==='DELETE'||!visible){if(index>=0)state[key]=current.filter(item=>item.id!==row.id);}else if(index>=0){state[key]=current.map(item=>item.id===row.id?row:item);}else{state[key]=[...current,row];}renderCoordinator();}
function subscribeRealtime(){
  resetRealtime();if(!state.user)return;const channel=sb.channel(`portal-${state.user.id}`).on('postgres_changes',{event:'*',schema:'public',table:'portal_unidades_acessos',filter:`user_id=eq.${state.user.id}`},scheduleReload);if(state.unitId){['portal_salas','portal_inventario','portal_pedidos_itens'].forEach(table=>channel.on('postgres_changes',{event:'*',schema:'public',table,filter:`unidade_id=eq.${state.unitId}`},applyCoordinatorChange));channel.on('postgres_changes',{event:'*',schema:'public',table:'portal_transferencias_inventario'},applyCoordinatorChange);}else{['portal_salas','portal_inventario','portal_pedidos_itens','portal_transferencias_inventario'].forEach(table=>channel.on('postgres_changes',{event:'*',schema:'public',table},scheduleReload));}state.channel=channel.subscribe();
}
function scheduleReload(){clearTimeout(reloadTimer);reloadTimer=setTimeout(()=>state.isPortalManager?(state.unitId?loadCoordinatorData():loadAdminData()):state.access?.status==='APROVADO'?loadCoordinatorData():routeSession(state.session),350);}

document.addEventListener('DOMContentLoaded',async()=>{
  await loadUnits();
  $('show-register').onclick=()=>{$('login-view').hidden=true;$('register-view').hidden=false};$('show-login').onclick=()=>{$('register-view').hidden=true;$('login-view').hidden=false};
  $('login-form').onsubmit=async e=>{e.preventDefault();setBusy(e.currentTarget,true,'Entrando...');const {data,error}=await sb.auth.signInWithPassword({email:$('login-email').value.trim(),password:$('login-password').value});setBusy(e.currentTarget,false);if(error)return toast('E-mail ou senha inválidos.','error');await routeSession(data.session)};
  $('register-form').onsubmit=async e=>{e.preventDefault();if($('register-password').value!==$('register-password-confirm').value)return toast('As senhas não conferem.','error');setBusy(e.currentTarget,true,'Enviando...');const {error}=await sb.auth.signUp({email:$('register-email').value.trim(),password:$('register-password').value,options:{emailRedirectTo:new URL('index.html',location.href).href,data:{portal_unidades:'true',nome:$('register-name').value.trim(),unidade_id:$('register-unit').value}}});setBusy(e.currentTarget,false);if(error)return toast(error.message,'error');toast('Solicitação criada. Confira seu e-mail e aguarde a aprovação.');$('register-view').hidden=true;$('login-view').hidden=false;e.currentTarget.reset()};
  $('signout').onclick=$('pending-signout').onclick=async()=>{await sb.auth.signOut();showOnly('auth-screen')};$('pending-refresh').onclick=async()=>{const {data}=await sb.auth.getSession();await routeSession(data.session)};
  const legacyOverviewNav=document.querySelector('.nav-item[data-tab="overview"]');if(legacyOverviewNav)legacyOverviewNav.hidden=true;const adminNav=document.querySelector('.nav-item[data-tab="admin"]');if(adminNav)adminNav.lastChild.textContent='Visão geral';const adminHeading=document.querySelector('#tab-admin .page-heading h1');if(adminHeading)adminHeading.textContent='Visão geral';
  document.querySelectorAll('.nav-item').forEach(b=>b.onclick=async()=>{if(state.isPortalManager&&['admin','approvals'].includes(b.dataset.tab))await loadAdminData();openTab(b.dataset.tab)});document.querySelectorAll('[data-goto]').forEach(b=>b.onclick=()=>openTab(b.dataset.goto));
  $('toggle-room-form').onclick=()=>toggleForm('room-form');document.querySelectorAll('[data-close-form]').forEach(b=>b.onclick=()=>{if(b.dataset.closeForm==='inventory-form'){$('inventory-room').disabled=false;resetInventoryBatch();}if(b.dataset.closeForm==='order-form'){$('order-room').disabled=false;resetOrderBatch();}toggleForm(b.dataset.closeForm,false)});
  $('room-form').onsubmit=submitRoom;$('inventory-form').onsubmit=submitInventory;$('order-form').onsubmit=submitOrder;
  $('inventory-add-type').onclick=()=>{const group=addInventoryBatchGroup();group?.querySelector('.inventory-batch-name').focus()};$('inventory-batch-list').oninput=e=>{if(e.target.matches('.inventory-batch-quantity')&&e.target.value)syncInventoryBatchGroup(e.target.closest('.inventory-batch-group'))};$('inventory-batch-list').onchange=e=>{if(e.target.matches('.inventory-batch-quantity'))syncInventoryBatchGroup(e.target.closest('.inventory-batch-group'))};$('inventory-batch-list').onclick=e=>{const button=e.target.closest('[data-inventory-batch-remove]');if(!button)return;button.closest('.inventory-batch-group').remove();updateInventoryBatchTotal()};resetInventoryBatch();
  $('order-add-item').onclick=()=>{const row=addOrderBatchItem();row?.querySelector('.order-batch-name').focus()};$('order-batch-list').oninput=e=>{if(e.target.matches('.order-batch-quantity'))updateOrderBatchTotal()};$('order-batch-list').onclick=e=>{const button=e.target.closest('[data-order-batch-remove]');if(!button)return;button.closest('.order-batch-row').remove();updateOrderBatchTotal()};resetOrderBatch();
  document.querySelectorAll('.inventory-subtab').forEach(button=>button.onclick=()=>switchInventoryView(button.dataset.inventoryView));$('inventory-action-form').onsubmit=submitInventoryAction;$('close-inventory-action').onclick=$('cancel-inventory-action').onclick=closeInventoryAction;$('inventory-action-modal').onclick=e=>{if(e.target===$('inventory-action-modal'))closeInventoryAction()};
  $('inventory-room-filter').onchange=renderInventory;$('inventory-search').oninput=renderInventory;$('order-search').oninput=renderOrders;$('admin-search').oninput=renderAdminOverview;$('admin-unit-filter').onchange=renderAdminOverview;
  document.querySelectorAll('.admin-subtab').forEach(b=>b.onclick=()=>switchAdminSubtab(b.dataset.adminSubtab));$('admin-inventory-search').oninput=renderAdminInventory;
  $('admin-unit-switch').onchange=e=>switchAdminUnit(e.target.value);
  $('open-export').onclick=openExportModal;$('close-export').onclick=closeExportModal;$('export-unit-search').oninput=renderExportUnits;$('export-select-all').onclick=()=>{state.units.forEach(u=>state.exportUnitIds.add(String(u.id)));renderExportUnits()};$('export-clear').onclick=()=>{state.exportUnitIds.clear();renderExportUnits()};$('export-unit-list').onchange=e=>{const input=e.target.closest('input[type="checkbox"]');if(!input)return;input.checked?state.exportUnitIds.add(input.value):state.exportUnitIds.delete(input.value);updateExportSelectedCount()};$('download-export').onclick=downloadAdminExport;$('export-modal').onclick=e=>{if(e.target===$('export-modal'))closeExportModal()};['inventory-form','order-form'].forEach(id=>{$(`${id}-modal`).onclick=e=>{if(e.target===$(`${id}-modal`)){if(id==='inventory-form'){$('inventory-room').disabled=false;resetInventoryBatch();}else{$('order-room').disabled=false;resetOrderBatch();}toggleForm(id,false);}}});document.addEventListener('keydown',e=>{if(e.key!=='Escape')return;if(!$('inventory-form-modal').hidden){$('inventory-room').disabled=false;resetInventoryBatch();toggleForm('inventory-form',false);}else if(!$('order-form-modal').hidden){$('order-room').disabled=false;resetOrderBatch();toggleForm('order-form',false);}else if(!$('inventory-action-modal').hidden)closeInventoryAction();else if(!$('export-modal').hidden)closeExportModal()});
  document.body.addEventListener('click',async e=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.inventoryMove)openInventoryAction('move',b.dataset.inventoryMove);else if(b.dataset.inventoryUnserviceable)openInventoryAction('unserviceable',b.dataset.inventoryUnserviceable);else if(b.dataset.inventoryTransfer)openInventoryAction('transfer',b.dataset.inventoryTransfer);else if(b.dataset.transferReceive)openInventoryAction('receive',b.dataset.transferReceive);else if(b.dataset.inventoryRemove)await updateItem('portal_inventario',b.dataset.inventoryRemove,{ativo:false},'Item retirado do inventário.');else if(b.dataset.orderQty)await changeOrderQty(b.dataset.orderQty,b.dataset.delta);else if(b.dataset.orderCancel)await updateItem('portal_pedidos_itens',b.dataset.orderCancel,{status:'CANCELADO'},'Item cancelado.');else if(b.dataset.orderAttend)await updateItem('portal_pedidos_itens',b.dataset.orderAttend,{status:'ATENDIDO'},'Item marcado como atendido.');else if(b.dataset.approve)await reviewAccess(b.dataset.approve,'APROVADO');else if(b.dataset.reject)await reviewAccess(b.dataset.reject,'REJEITADO')});
  document.body.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.inventoryAddRoom)openInventoryFormForRoom(b.dataset.inventoryAddRoom);else if(b.dataset.orderAddRoom)openOrderFormForRoom(b.dataset.orderAddRoom);});
  const {data}=await sb.auth.getSession();await routeSession(data.session);sb.auth.onAuthStateChange((_event,session)=>{if(session?.access_token!==state.session?.access_token)setTimeout(()=>routeSession(session),0)});
});
