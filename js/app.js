const {createClient}=supabase;
const sb=createClient(PORTAL_CONFIG.supabaseUrl,PORTAL_CONFIG.supabaseKey);

const state={session:null,user:null,profile:null,access:null,isPortalManager:false,unitId:null,units:[],rooms:[],adminRooms:[],inventory:[],orders:[],adminOrders:[],adminInventory:[],consolidated:[],approvals:[],channel:null,tab:'overview',adminSubtab:'orders',exportUnitIds:new Set()};
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
function showOnly(id){['auth-screen','pending-screen','app-screen'].forEach(x=>$(x).hidden=x!==id);}
function openTab(name){
  state.tab=name;document.querySelectorAll('.tab-panel').forEach(p=>p.hidden=p.id!==`tab-${name}`);
  document.querySelectorAll('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.tab===name));
}
function toggleForm(id,force){const el=$(id);el.hidden=force===undefined?!el.hidden:!force;if(!el.hidden)el.querySelector('input,select,textarea')?.focus();}

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
  await loadCoordinatorData();openTab('overview');subscribeRealtime();
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
  await loadCoordinatorData();openTab('overview');subscribeRealtime();
}
async function switchAdminUnit(value){
  if(!state.isPortalManager)return;
  document.querySelectorAll('.inline-form').forEach(form=>form.hidden=true);
  if(!value){state.unitId=null;await startAdmin();return;}
  await startAdminUnit(value);
}

async function loadCoordinatorData(){
  const [rooms,inventory,orders]=await Promise.all([
    sb.from('portal_salas').select('*').eq('unidade_id',state.unitId).eq('ativo',true).order('nome'),
    sb.from('portal_inventario').select('*').eq('unidade_id',state.unitId).eq('ativo',true).order('item_nome'),
    sb.from('portal_pedidos_itens').select('*').eq('unidade_id',state.unitId).eq('status','ATIVO').order('atualizado_em',{ascending:false})
  ]);
  const error=rooms.error||inventory.error||orders.error;if(error){toast(error.message,'error');return;}
  state.rooms=rooms.data||[];state.inventory=inventory.data||[];state.orders=orders.data||[];
  renderCoordinator();
}
function renderCoordinator(){renderRoomOptions();renderMetrics();renderOverview();renderInventory();renderOrders();}
function renderRoomOptions(){
  const opts=state.rooms.map(r=>`<option value="${r.id}">${esc(r.nome)}</option>`).join('');
  $('inventory-room').innerHTML=state.rooms.length?'<option value="">Selecione</option>'+opts:'<option value="">Cadastre uma sala primeiro</option>';
  $('order-room').innerHTML=state.rooms.length?'<option value="">Selecione a sala</option>'+opts:'<option value="">Cadastre uma sala primeiro</option>';
  const current=$('inventory-room-filter').value;$('inventory-room-filter').innerHTML='<option value="">Todas as salas</option>'+opts;$('inventory-room-filter').value=current;
}
function renderMetrics(){
  const inventoryQty=state.inventory.reduce((s,i)=>s+Number(i.quantidade||0),0),orderQty=state.orders.reduce((s,i)=>s+Number(i.quantidade||0),0);
  $('metric-rooms').textContent=state.rooms.length;$('metric-inventory').textContent=state.inventory.length;$('metric-inventory-units').textContent=`${inventoryQty} unidades físicas`;$('metric-orders').textContent=state.orders.length;$('metric-order-units').textContent=`${orderQty} unidades solicitadas`;
}
function renderOverview(){
  $('overview-orders').innerHTML=state.orders.length?state.orders.slice(0,5).map(o=>`<div class="simple-row"><div><strong>${esc(o.item_nome)}</strong><small>${esc(o.categoria||'Sem categoria')} · ${esc(roomName(o.sala_id))}</small></div><b>${o.quantidade} ${esc(o.unidade_medida.toLowerCase())}</b></div>`).join(''):'Nenhum pedido ativo.';
  const counts=state.rooms.map(r=>({name:r.nome,count:state.inventory.filter(i=>i.sala_id===r.id).reduce((s,i)=>s+Number(i.quantidade),0)}));const max=Math.max(1,...counts.map(x=>x.count));
  $('overview-rooms').innerHTML=counts.length?counts.map(x=>`<div class="bar-row"><span>${esc(x.name)}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.round(x.count/max*100)}%"></div></div><b>${x.count}</b></div>`).join(''):'Nenhuma sala cadastrada.';
}
function filteredInventory(){const room=$('inventory-room-filter').value,q=$('inventory-search').value.trim().toLowerCase();return state.inventory.filter(i=>(!room||i.sala_id===room)&&(!q||[i.item_nome,i.patrimonio,i.numero_serie,i.marca,i.modelo].join(' ').toLowerCase().includes(q)));}
function openInventoryFormForRoom(roomId){const sel=$('inventory-room');sel.value=String(roomId);sel.disabled=true;toggleForm('inventory-form',true);$('inventory-name').focus();}
function openOrderFormForRoom(roomId){const sel=$('order-room');sel.value=String(roomId);sel.disabled=true;toggleForm('order-form',true);$('order-name').focus();}

function renderInventory(){
  const rows=filteredInventory();$('inventory-table').innerHTML=rows.length?rows.map(i=>`<tr><td><strong>${esc(i.item_nome)}</strong><small>${esc([i.marca,i.modelo].filter(Boolean).join(' · ')||i.categoria||'')}</small></td><td>${esc(state.rooms.find(r=>r.id===i.sala_id)?.nome||'—')}</td><td>${i.quantidade}</td><td>${esc(i.patrimonio||'—')}<small>${esc(i.numero_serie||'')}</small></td><td><span class="state-pill state-${i.estado}">${esc(i.estado)}</span></td><td>${fmtDate(i.atualizado_em)}</td><td><div class="row-actions"><button class="icon-btn" data-inventory-qty="${i.id}" data-delta="1" title="Aumentar quantidade">+</button><button class="icon-btn" data-inventory-qty="${i.id}" data-delta="-1" title="Diminuir quantidade">−</button><button class="icon-btn" data-inventory-remove="${i.id}" title="Retirar do inventário">Retirar</button></div></td></tr>`).join(''):'<tr><td colspan="7" class="empty-state">Nenhum item encontrado.</td></tr>';
}
function filteredOrders(){const q=$('order-search').value.trim().toLowerCase();return state.orders.filter(o=>!q||[o.item_nome,o.categoria,o.especificacao,o.justificativa,roomName(o.sala_id)].join(' ').toLowerCase().includes(q));}
function renderInventory(){
  const rows=filteredInventory(),tableWrap=$('inventory-table')?.closest('.table-wrap');if(!tableWrap)return;
  tableWrap.hidden=true;let host=$('inventory-room-cards');if(!host){host=document.createElement('div');host.id='inventory-room-cards';tableWrap.after(host);}
  if(!rows.length){host.innerHTML='<div class="panel empty-state">Nenhum item encontrado.</div>';return;}
  const groups=new Map();rows.forEach(item=>{const key=String(item.sala_id||'sem-sala'),group=groups.get(key)||{nome:roomName(item.sala_id),items:[],quantidade:0};group.items.push(item);group.quantidade+=Number(item.quantidade||0);groups.set(key,group);});
  host.innerHTML=[...groups.values()].sort((a,b)=>a.nome.localeCompare(b.nome,'pt-BR')).map(group=>`<details class="inventory-room-card"><summary class="inventory-room-summary"><span><strong>${esc(group.nome)}</strong><small>${group.items.length} ${group.items.length===1?'item':'itens'} cadastrados</small></span><b>${group.quantidade} unidades</b></summary><div class="inventory-room-body">${group.items.map(item=>`<div class="inventory-room-item"><div class="inventory-room-item-main"><strong>${esc(item.item_nome)}</strong><small>${esc([item.marca,item.modelo].filter(Boolean).join(' · ')||'Sem marca ou modelo')}</small>${item.patrimonio||item.numero_serie?`<p>${item.patrimonio?`Patrimônio: ${esc(item.patrimonio)}`:''}${item.patrimonio&&item.numero_serie?' · ':''}${item.numero_serie?`Série: ${esc(item.numero_serie)}`:''}</p>`:''}</div><span class="state-pill state-${esc(item.estado)}">${esc(item.estado)}</span><div class="inventory-room-actions"><button class="icon-btn" data-inventory-qty="${item.id}" data-delta="-1" title="Diminuir quantidade">−</button><strong>${item.quantidade}</strong><button class="icon-btn" data-inventory-qty="${item.id}" data-delta="1" title="Aumentar quantidade">+</button><button class="icon-btn" data-inventory-remove="${item.id}">Retirar</button></div></div>`).join('')}</div></details>`).join('');
  host.querySelectorAll('.inventory-room-card').forEach(card=>{const roomNameText=card.querySelector('.inventory-room-summary strong')?.textContent||'',room=state.rooms.find(r=>r.nome===roomNameText);if(!room)return;card.querySelector('.inventory-room-body').insertAdjacentHTML('beforeend',`<div class="room-add-action"><button class="btn btn-secondary" data-inventory-add-room="${room.id}">+ Adicionar item nesta sala</button></div>`);});
}

function renderOrders(){
  const rows=filteredOrders(),qty=state.orders.reduce((s,o)=>s+Number(o.quantidade),0);$('cart-count').textContent=`${state.orders.length} ${state.orders.length===1?'item':'itens'}`;$('cart-total').textContent=`${qty} unidades solicitadas`;
  $('orders-list').innerHTML=rows.length?rows.map(o=>`<article class="cart-item"><div class="cart-item-head"><div><h3>${esc(o.item_nome)}</h3><p>${esc(o.categoria||'Sem categoria')}</p></div><span class="priority-pill priority-${o.prioridade}">${esc(o.prioridade)}</span></div><div class="cart-meta"><span class="status-pill">${esc(roomName(o.sala_id))}</span><span class="status-pill">${esc(o.unidade_medida)}</span>${o.especificacao?`<span class="status-pill">Com especificação</span>`:''}</div>${o.justificativa?`<p>${esc(o.justificativa)}</p>`:''}<div class="cart-footer"><div class="qty-control"><button data-order-qty="${o.id}" data-delta="-1">−</button><strong>${o.quantidade}</strong><button data-order-qty="${o.id}" data-delta="1">+</button></div><button class="text-button" data-order-cancel="${o.id}">Cancelar item</button></div></article>`).join(''):'<div class="panel empty-state">Sua lista de compras ainda está vazia.</div>';
}

function renderOrders(){
  const rows=filteredOrders(),qty=state.orders.reduce((s,o)=>s+Number(o.quantidade||0),0);
  $('cart-count').textContent=`${state.orders.length} ${state.orders.length===1?'item':'itens'}`;$('cart-total').textContent=`${qty} unidades solicitadas`;
  if(!rows.length){$('orders-list').innerHTML='<div class="panel empty-state">Sua lista de compras ainda está vazia.</div>';return;}
  const summary=new Map();rows.forEach(o=>{const key=[String(o.item_nome||'').trim().toLowerCase(),String(o.unidade_medida||'')].join('|'),item=summary.get(key)||{nome:o.item_nome,unidade:o.unidade_medida,quantidade:0};item.quantidade+=Number(o.quantidade||0);summary.set(key,item);});
  const summaryHtml=[...summary.values()].sort((a,b)=>a.nome.localeCompare(b.nome,'pt-BR')).map(i=>`<div class="order-summary-row"><div><strong>${esc(i.nome)}</strong><small>${esc(i.unidade.toLowerCase())}</small></div><b>${i.quantidade} ${esc(i.unidade.toLowerCase())}</b></div>`).join('');
  const rooms=new Map();rows.forEach(o=>{const key=String(o.sala_id||'sem-sala'),group=rooms.get(key)||{nome:roomName(o.sala_id),items:[],quantidade:0};group.items.push(o);group.quantidade+=Number(o.quantidade||0);rooms.set(key,group);});
  const roomHtml=[...rooms.values()].sort((a,b)=>a.nome.localeCompare(b.nome,'pt-BR')).map(group=>`<details class="room-order-card"><summary class="room-order-summary"><span><strong>${esc(group.nome)}</strong><small>${group.items.length} ${group.items.length===1?'item':'itens'} aguardando pedido</small></span><b>${group.quantidade} unidades</b></summary><div class="room-order-body">${group.items.map(o=>`<div class="room-order-item"><div class="room-order-item-main"><strong>${esc(o.item_nome)}</strong><small>${esc(o.prioridade)} · ${esc(o.unidade_medida.toLowerCase())}</small>${o.justificativa?`<p>${esc(o.justificativa)}</p>`:''}</div><div class="room-order-item-actions"><div class="qty-control"><button data-order-qty="${o.id}" data-delta="-1">−</button><strong>${o.quantidade}</strong><button data-order-qty="${o.id}" data-delta="1">+</button></div><button class="text-button" data-order-cancel="${o.id}">Cancelar item</button></div></div>`).join('')}</div></details>`).join('');
  $('orders-list').innerHTML=`<section class="orders-summary"><div class="orders-summary-head"><div><p class="eyebrow">Resumo dos pedidos</p><h2>Todos os itens</h2></div><span>${summary.size} ${summary.size===1?'tipo de item':'tipos de itens'}</span></div><div class="orders-summary-grid">${summaryHtml}</div></section><div class="orders-by-room"><div class="orders-by-room-title"><p class="eyebrow">Detalhamento</p><h2>Pedidos por sala</h2></div>${roomHtml}</div>`;
  document.querySelectorAll('#orders-list .room-order-card').forEach(card=>{const roomNameText=card.querySelector('.room-order-summary strong')?.textContent||'',room=state.rooms.find(r=>r.nome===roomNameText);if(!room)return;card.querySelector('.room-order-body').insertAdjacentHTML('beforeend',`<div class="room-add-action"><button class="btn btn-secondary" data-order-add-room="${room.id}">+ Adicionar pedido nesta sala</button></div>`);});
}

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
function switchAdminSubtab(name){state.adminSubtab=name;document.querySelectorAll('.admin-subtab').forEach(b=>{const active=b.dataset.adminSubtab===name;b.classList.toggle('active',active);b.setAttribute('aria-selected',String(active));});document.querySelectorAll('#tab-admin > .page-heading,#tab-admin > .toolbar,#tab-admin > .table-wrap,#tab-admin > .section-title,#admin-orders-by-unit').forEach(el=>{el.hidden=name!=='orders';});$('admin-subtab-inventory').hidden=name!=='inventory';if(name==='inventory')renderAdminInventory();}
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
async function submitInventory(e){e.preventDefault();if(!state.rooms.length)return toast('Cadastre uma sala primeiro.','error');setBusy(e.currentTarget,true,'Salvando...');const payload={unidade_id:state.unitId,sala_id:$('inventory-room').value,item_nome:$('inventory-name').value.trim(),categoria:$('inventory-category').value.trim()||null,quantidade:Number($('inventory-quantity').value),patrimonio:$('inventory-asset').value.trim()||null,numero_serie:$('inventory-serial').value.trim()||null,marca:$('inventory-brand').value.trim()||null,modelo:$('inventory-model').value.trim()||null,estado:$('inventory-state').value,observacoes:$('inventory-notes').value.trim()||null,criado_por:state.user.id,atualizado_por:state.user.id};const {error}=await sb.from('portal_inventario').insert(payload);setBusy(e.currentTarget,false);if(error)return toast(error.message,'error');e.currentTarget.reset();$('inventory-quantity').value=1;toggleForm('inventory-form',false);toast('Item incluído no inventário.');await loadCoordinatorData();}
async function submitOrder(e){e.preventDefault();if(!state.rooms.length)return toast('Cadastre uma sala antes de solicitar um item.','error');setBusy(e.currentTarget,true,'Adicionando...');const payload={unidade_id:state.unitId,sala_id:$('order-room').value,item_nome:$('order-name').value.trim(),categoria:$('order-category').value.trim()||null,quantidade:Number($('order-quantity').value),unidade_medida:$('order-unit').value,prioridade:$('order-priority').value,especificacao:$('order-spec').value.trim()||null,justificativa:$('order-justification').value.trim()||null,criado_por:state.user.id,atualizado_por:state.user.id};const {error}=await sb.from('portal_pedidos_itens').insert(payload);setBusy(e.currentTarget,false);if(error)return toast(error.message,'error');e.currentTarget.reset();$('order-quantity').value=1;toggleForm('order-form',false);toast('Item adicionado à lista de compras.');await loadCoordinatorData();}
async function changeQty(table,id,delta){const list=table==='portal_inventario'?state.inventory:state.orders,row=list.find(x=>x.id===id);if(!row)return;const next=Number(row.quantidade)+Number(delta);if(next<1)return toast('A quantidade mínima é 1.','error');const {error}=await sb.from(table).update({quantidade:next}).eq('id',id);if(error)return toast(error.message,'error');await loadCoordinatorData();}
async function updateItem(table,id,patch,message){const {error}=await sb.from(table).update(patch).eq('id',id);if(error)return toast(error.message,'error');toast(message);state.isPortalManager&&!state.unitId?await loadAdminData():await loadCoordinatorData();}
async function submitOrder(e){e.preventDefault();if(!state.rooms.length)return toast('Cadastre uma sala antes de solicitar um item.','error');const room=$('order-room').value,name=$('order-name').value.trim(),quantity=Number($('order-quantity').value),unit=$('order-unit').value,priority=$('order-priority').value,justification=$('order-justification').value.trim();if(!room||!name||!Number.isFinite(quantity)||quantity<1||!unit||!priority||!justification)return toast('Preencha todos os campos obrigatórios do pedido.','error');setBusy(e.currentTarget,true,'Adicionando...');const payload={unidade_id:state.unitId,sala_id:room,item_nome:name,quantidade,unidade_medida:unit,prioridade:priority,justificativa:justification,criado_por:state.user.id,atualizado_por:state.user.id};const {error}=await sb.from('portal_pedidos_itens').insert(payload);setBusy(e.currentTarget,false);if(error)return toast(error.message,'error');e.currentTarget.reset();toggleForm('order-form',false);toast('Item adicionado à lista de compras.');await loadCoordinatorData();}
async function reviewAccess(id,status){
  const row=state.approvals.find(a=>a.user_id===id);if(!row)return;
  const {error}=await sb.from('portal_unidades_acessos').update({status,unidade_id:status==='APROVADO'?row.unidade_solicitada_id:null}).eq('user_id',id);
  if(error)return toast(error.message,'error');
  toast(status==='APROVADO'?'Acesso aprovado.':'Solicitação rejeitada.');await loadAdminData();
}

function resetRealtime(){if(state.channel){sb.removeChannel(state.channel);state.channel=null;}}
function subscribeRealtime(){
  resetRealtime();if(!state.user)return;state.channel=sb.channel(`portal-${state.user.id}`).on('postgres_changes',{event:'*',schema:'public',table:'portal_unidades_acessos'},scheduleReload).on('postgres_changes',{event:'*',schema:'public',table:'portal_salas'},scheduleReload).on('postgres_changes',{event:'*',schema:'public',table:'portal_inventario'},scheduleReload).on('postgres_changes',{event:'*',schema:'public',table:'portal_pedidos_itens'},scheduleReload).subscribe();
}
function scheduleReload(){clearTimeout(reloadTimer);reloadTimer=setTimeout(()=>state.isPortalManager?(state.unitId?loadCoordinatorData():loadAdminData()):state.access?.status==='APROVADO'?loadCoordinatorData():routeSession(state.session),350);}

document.addEventListener('DOMContentLoaded',async()=>{
  await loadUnits();
  $('show-register').onclick=()=>{$('login-view').hidden=true;$('register-view').hidden=false};$('show-login').onclick=()=>{$('register-view').hidden=true;$('login-view').hidden=false};
  $('login-form').onsubmit=async e=>{e.preventDefault();setBusy(e.currentTarget,true,'Entrando...');const {data,error}=await sb.auth.signInWithPassword({email:$('login-email').value.trim(),password:$('login-password').value});setBusy(e.currentTarget,false);if(error)return toast('E-mail ou senha inválidos.','error');await routeSession(data.session)};
  $('register-form').onsubmit=async e=>{e.preventDefault();if($('register-password').value!==$('register-password-confirm').value)return toast('As senhas não conferem.','error');setBusy(e.currentTarget,true,'Enviando...');const {error}=await sb.auth.signUp({email:$('register-email').value.trim(),password:$('register-password').value,options:{emailRedirectTo:new URL('index.html',location.href).href,data:{portal_unidades:'true',nome:$('register-name').value.trim(),unidade_id:$('register-unit').value}}});setBusy(e.currentTarget,false);if(error)return toast(error.message,'error');toast('Solicitação criada. Confira seu e-mail e aguarde a aprovação.');$('register-view').hidden=true;$('login-view').hidden=false;e.currentTarget.reset()};
  $('signout').onclick=$('pending-signout').onclick=async()=>{await sb.auth.signOut();showOnly('auth-screen')};$('pending-refresh').onclick=async()=>{const {data}=await sb.auth.getSession();await routeSession(data.session)};
  document.querySelectorAll('.nav-item').forEach(b=>b.onclick=async()=>{if(state.isPortalManager&&['admin','approvals'].includes(b.dataset.tab))await loadAdminData();openTab(b.dataset.tab)});document.querySelectorAll('[data-goto]').forEach(b=>b.onclick=()=>openTab(b.dataset.goto));
  $('toggle-room-form').onclick=()=>toggleForm('room-form');document.querySelectorAll('[data-close-form]').forEach(b=>b.onclick=()=>{if(b.dataset.closeForm==='inventory-form')$('inventory-room').disabled=false;if(b.dataset.closeForm==='order-form')$('order-room').disabled=false;toggleForm(b.dataset.closeForm,false)});
  $('room-form').onsubmit=submitRoom;$('inventory-form').onsubmit=submitInventory;$('order-form').onsubmit=submitOrder;
  $('inventory-room-filter').onchange=renderInventory;$('inventory-search').oninput=renderInventory;$('order-search').oninput=renderOrders;$('admin-search').oninput=renderAdminOverview;$('admin-unit-filter').onchange=renderAdminOverview;
  document.querySelectorAll('.admin-subtab').forEach(b=>b.onclick=()=>switchAdminSubtab(b.dataset.adminSubtab));$('admin-inventory-search').oninput=renderAdminInventory;
  $('admin-unit-switch').onchange=e=>switchAdminUnit(e.target.value);
  $('open-export').onclick=openExportModal;$('close-export').onclick=closeExportModal;$('export-unit-search').oninput=renderExportUnits;$('export-select-all').onclick=()=>{state.units.forEach(u=>state.exportUnitIds.add(String(u.id)));renderExportUnits()};$('export-clear').onclick=()=>{state.exportUnitIds.clear();renderExportUnits()};$('export-unit-list').onchange=e=>{const input=e.target.closest('input[type="checkbox"]');if(!input)return;input.checked?state.exportUnitIds.add(input.value):state.exportUnitIds.delete(input.value);updateExportSelectedCount()};$('download-export').onclick=downloadAdminExport;$('export-modal').onclick=e=>{if(e.target===$('export-modal'))closeExportModal()};document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('export-modal').hidden)closeExportModal()});
  document.body.addEventListener('click',async e=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.inventoryQty)await changeQty('portal_inventario',b.dataset.inventoryQty,b.dataset.delta);else if(b.dataset.inventoryRemove)await updateItem('portal_inventario',b.dataset.inventoryRemove,{ativo:false},'Item retirado do inventário.');else if(b.dataset.orderQty)await changeQty('portal_pedidos_itens',b.dataset.orderQty,b.dataset.delta);else if(b.dataset.orderCancel)await updateItem('portal_pedidos_itens',b.dataset.orderCancel,{status:'CANCELADO'},'Item cancelado.');else if(b.dataset.orderAttend)await updateItem('portal_pedidos_itens',b.dataset.orderAttend,{status:'ATENDIDO'},'Item marcado como atendido.');else if(b.dataset.approve)await reviewAccess(b.dataset.approve,'APROVADO');else if(b.dataset.reject)await reviewAccess(b.dataset.reject,'REJEITADO')});
  document.body.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.inventoryAddRoom)openInventoryFormForRoom(b.dataset.inventoryAddRoom);else if(b.dataset.orderAddRoom)openOrderFormForRoom(b.dataset.orderAddRoom);});
  const {data}=await sb.auth.getSession();await routeSession(data.session);sb.auth.onAuthStateChange((_event,session)=>{if(session?.access_token!==state.session?.access_token)setTimeout(()=>routeSession(session),0)});
});
