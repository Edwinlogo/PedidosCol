/* Pedidos Colombina - lógica principal */
(() => {
  'use strict';

  const S = {
    products: new Map(),
    clients: [],
    inventory: null,
    settings: { radius: 150, deduct: true, theme: 'auto' },
    committed: new Map(),
    position: null,
    draft: null,
    selectedOrders: new Set(),
    installEvt: null,
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const fmt = (n) => (Number(n) || 0).toLocaleString('es-CO', { maximumFractionDigits: 3 });
  const pad = (n) => String(n).padStart(2, '0');
  const isoDay = (d) => { d = new Date(d); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const fmtDay = (iso) => { if (!iso) return ''; const [y, m, d] = iso.slice(0, 10).split('-'); return `${d}/${m}/${y}`; };
  const fmtShort = (iso) => { if (!iso) return ''; const [, m, d] = iso.slice(0, 10).split('-'); return `${d}/${m}`; };
  const fmtTime = (iso) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const fmtDist = (m) => (m == null ? '' : m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);
  const debounce = (fn, ms = 150) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  function toast(msg, ms = 2400) {
    const t = $('#toast');
    if (!msg) { t.classList.add('hidden'); return; }
    t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), ms);
  }
  function openModal(title, html) {
    $('#modalTitle').textContent = title;
    const body = $('#modalBody');
    if (typeof html === 'string') body.innerHTML = html; else { body.innerHTML = ''; body.appendChild(html); }
    $('#modal').classList.remove('hidden');
    return body;
  }
  function closeModal() { $('#modal').classList.add('hidden'); $('#modalBody').innerHTML = ''; }

  function haversine(a, b) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  const hasCoords = (c) => c && typeof c.lat === 'number' && typeof c.lng === 'number' && !isNaN(c.lat) && !isNaN(c.lng);
  const clientDist = (c) => (S.position && hasCoords(c) ? haversine(S.position, c) : null);
  const clientById = (id) => S.clients.find(c => c.id === id);

  function downloadBlob(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 3000);
  }
  async function shareBlob(blob, filename, title) {
    const file = new File([blob], filename, { type: blob.type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title }); return true; } catch (e) { if (e.name === 'AbortError') return true; }
    }
    downloadBlob(blob, filename); return false;
  }
  const slug = (s) => norm(s).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'cliente';

  /* ======================= Tema claro / oscuro ======================= */
  const darkMedia = window.matchMedia('(prefers-color-scheme: dark)');
  function isDark() {
    return S.settings.theme === 'dark' || (S.settings.theme === 'auto' && darkMedia.matches);
  }
  function applyTheme() {
    const dark = isDark();
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    $('#btnTheme').textContent = dark ? '☀️' : '🌙';
    $('#metaTheme').content = dark ? '#152259' : '#22357f';
    $$('#themeSeg button').forEach(b => b.classList.toggle('on', b.dataset.theme === S.settings.theme));
  }
  darkMedia.addEventListener?.('change', applyTheme);

  /* ======================= Datos ======================= */
  async function loadAll() {
    const [products, clients, inv, settings] = await Promise.all([
      DB.all('products'), DB.all('clients'), DB.getMeta('inventory'), DB.getMeta('settings'),
    ]);
    S.products = new Map(products.map(p => [p.code, p]));
    S.clients = clients;
    S.inventory = inv;
    S.settings = { ...S.settings, ...(settings || {}) };
    applyTheme();
    await computeCommitted();
  }

  async function computeCommitted() {
    S.committed = new Map();
    if (!S.inventory) return;
    const since = S.inventory.importedAt;
    const orders = await DB.all('orders');
    orders.forEach(o => {
      if (o.date < since) return;
      if (S.draft && S.draft.editingId === o.id) return;
      o.lines.forEach(l => { if ((l.unit || 'CAR') === 'CAR') S.committed.set(l.code, (S.committed.get(l.code) || 0) + Number(l.qty || 0)); });
    });
  }

  function available(code) {
    const p = S.products.get(code);
    if (!p) return null;
    return p.disponible - (S.settings.deduct ? (S.committed.get(code) || 0) : 0);
  }
  function stockBadge(code) {
    const a = available(code);
    if (a === null) return '<span class="stock none">S/I</span>';
    const cls = a <= 0 ? 'none' : a < 5 ? 'low' : '';
    return `<span class="stock ${cls}">${fmt(a)}</span>`;
  }

  /* ======================= Navegación ======================= */
  const TITLES = { pedido: 'Pedido', historial: 'Pedidos', clientes: 'Clientes', inventario: 'Inventario', mas: 'Ajustes' };
  function showView(name) {
    $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${name}`));
    $$('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.view === name));
    $('#viewTitle').textContent = name === 'pedido' && S.draft?.editingId ? `Pedido #${S.draft.editingId}` : TITLES[name];
    if (name === 'historial') renderHistory();
    if (name === 'clientes') renderClients();
    if (name === 'inventario') renderInventory();
    if (name === 'mas') renderSettings();
    window.scrollTo(0, 0);
  }

  function renderHeader() {
    const inv = S.inventory;
    $('#invBadge').textContent = inv ? `Inv. ${fmtShort(inv.date)}` : 'Sin inv.';
    const banner = $('#banner');
    const today = isoDay(new Date());
    if (!inv) {
      banner.innerHTML = '<span>⚠ Sin inventario</span><button class="btn small" data-go="inventario">Cargar</button>';
      banner.classList.remove('hidden');
    } else if (inv.date < today) {
      banner.innerHTML = `<span>⚠ Inventario del <b>${fmtDay(inv.date)}</b></span><button class="btn small" data-go="inventario">Actualizar</button>`;
      banner.classList.remove('hidden');
    } else banner.classList.add('hidden');
  }

  /* ======================= Borrador ======================= */
  function newDraft() { return { clientId: null, autoClient: false, distance: null, lines: [], notes: '', editingId: null, origDate: null }; }
  function saveDraft() { localStorage.setItem('draft', JSON.stringify(S.draft)); }
  function loadDraft() {
    try { S.draft = JSON.parse(localStorage.getItem('draft')) || newDraft(); } catch { S.draft = newDraft(); }
  }

  function setClient(id, auto = false, distance = null) {
    const changed = S.draft.clientId !== id;
    S.draft.clientId = id; S.draft.autoClient = auto; S.draft.distance = distance;
    const c = clientById(id);
    if (changed && c && !S.draft.lines.length && c.products?.length) loadClientList(c, true);
    saveDraft(); renderClientCard(); renderLines();
  }

  function loadClientList(c, silent = false) {
    let added = 0;
    (c.products || []).forEach(p => {
      if (S.draft.lines.some(l => l.code === p.code)) return;
      const prod = S.products.get(p.code);
      S.draft.lines.push({ code: p.code, name: prod?.name || p.name || '', qty: p.qty ?? 1, unit: p.unit || 'CAR', discount: p.discount || '', bonus: '' });
      added++;
    });
    saveDraft(); renderLines();
    if (!silent || added) toast(`Lista cargada (${added})`);
  }

  function addLine(code) {
    const p = S.products.get(code);
    const ex = S.draft.lines.find(l => l.code === code);
    if (ex) { ex.qty = (Number(ex.qty) || 0) + 1; toast(`${p?.name || code}: ${fmt(ex.qty)}`); }
    else { S.draft.lines.unshift({ code, name: p?.name || '', qty: 1, unit: 'CAR', discount: '', bonus: '' }); toast('Agregado'); }
    saveDraft(); renderLines();
  }

  /* ======================= Ubicación ======================= */
  function locate(manual = false) {
    const st = $('#clientStatus');
    if (!('geolocation' in navigator)) { st.textContent = 'GPS no disponible'; return; }
    st.textContent = 'Ubicando…';
    navigator.geolocation.getCurrentPosition(pos => {
      S.position = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy, at: Date.now() };
      autoDetectClient(manual);
    }, () => {
      S.position = null;
      renderClientCard('Sin GPS');
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
  }

  function nearestClients(max = 5, within = 3000) {
    if (!S.position) return [];
    return S.clients.filter(hasCoords).map(c => ({ c, d: haversine(S.position, c) }))
      .filter(x => x.d <= within).sort((a, b) => a.d - b.d).slice(0, max);
  }

  function autoDetectClient(manual) {
    const near = nearestClients(1, Infinity)[0];
    const canAuto = !S.draft.clientId || (S.draft.autoClient && !S.draft.editingId) || manual;
    if (near) {
      const radius = Number(near.c.radius) || Number(S.settings.radius) || 150;
      const tol = Math.min(S.position.acc || 0, 100);
      if (near.d <= radius + tol && canAuto && !S.draft.editingId) {
        if (S.draft.clientId !== near.c.id) toast(`📍 ${near.c.name}`);
        setClient(near.c.id, true, near.d);
        return;
      }
    }
    if (S.draft.clientId) {
      const c = clientById(S.draft.clientId);
      S.draft.distance = clientDist(c); saveDraft();
    }
    renderClientCard();
  }

  function renderClientCard(errMsg) {
    const c = clientById(S.draft.clientId);
    const st = $('#clientStatus'), nm = $('#clientName'), info = $('#clientInfo');
    if (c) {
      const d = clientDist(c);
      st.textContent = (S.draft.autoClient ? '📍 Por GPS' : 'Cliente') + (d != null ? ` · ${fmtDist(d)}` : '');
      nm.textContent = c.name;
      info.textContent = [c.code && `#${c.code}`, c.address].filter(Boolean).join(' · ');
    } else {
      st.textContent = errMsg || (S.position ? `GPS ±${Math.round(S.position.acc)} m` : 'Sin ubicación');
      nm.textContent = 'Seleccionar cliente';
      info.textContent = '';
    }

    const near = nearestClients(4).filter(x => x.c.id !== S.draft.clientId);
    $('#nearbyList').innerHTML = near.map(x => `<span class="chip" data-client="${x.c.id}">${esc(x.c.name)} · ${fmtDist(x.d)}</span>`).join('');

    const acts = [];
    if (c?.products?.length) acts.push(`<button class="btn small" data-act="loadList">📋 Lista (${c.products.length})</button>`);
    if (c && S.position && !hasCoords(c)) acts.push('<button class="btn small" data-act="saveLoc">📍 Fijar aquí</button>');
    if (!c && S.position) acts.push('<button class="btn small" data-act="newClientHere">+ Nuevo aquí</button>');
    if (S.draft.editingId) acts.push(`<button class="btn small danger" data-act="cancelEdit">✕ Edición #${S.draft.editingId}</button>`);
    $('#clientActions').innerHTML = acts.join('');
  }

  function openClientPicker() {
    const body = openModal('Cliente', `
      <input type="search" id="pickSearch" placeholder="🔍 Buscar…" autocomplete="off">
      <div id="pickList" class="mt"></div>
      <button class="btn primary block mt" id="pickNew">+ Nuevo cliente</button>`);
    const render = () => {
      const q = norm($('#pickSearch', body).value).trim().split(/\s+/).filter(Boolean);
      const list = S.clients
        .filter(c => q.every(w => norm(`${c.name} ${c.code} ${c.address}`).includes(w)))
        .map(c => ({ c, d: clientDist(c) }))
        .sort((a, b) => (a.d ?? 1e12) - (b.d ?? 1e12) || a.c.name.localeCompare(b.c.name));
      $('#pickList', body).innerHTML = list.length ? list.slice(0, 100).map(({ c, d }) => `
        <div class="item" data-pick="${c.id}">
          <div class="grow min0"><div class="name truncate">${esc(c.name)}</div><div class="sub truncate">${esc([c.code, c.address].filter(Boolean).join(' · '))}</div></div>
          <span class="small muted">${d != null ? fmtDist(d) : hasCoords(c) ? '📍' : ''}</span>
        </div>`).join('') : '<div class="empty">Sin clientes</div>';
    };
    $('#pickSearch', body).addEventListener('input', debounce(render, 100));
    body.addEventListener('click', e => {
      const it = e.target.closest('[data-pick]');
      if (it) { setClient(Number(it.dataset.pick), false, null); closeModal(); }
      if (e.target.id === 'pickNew') openClientEditor(null, { useHere: true, selectAfter: true });
    });
    render();
  }

  /* ======================= Productos ======================= */
  function searchProducts(query, limit = 40) {
    const q = norm(query).trim();
    if (!q) return [];
    const words = q.split(/\s+/);
    const res = [];
    for (const p of S.products.values()) {
      const hay = norm(`${p.code} ${p.name} ${p.group}`);
      if (p.code.startsWith(q) || words.every(w => hay.includes(w))) res.push(p);
    }
    res.sort((a, b) => (b.code === q) - (a.code === q) || (b.ref ? 1 : 0) - (a.ref ? 1 : 0) || (available(b.code) > 0) - (available(a.code) > 0) || a.name.localeCompare(b.name));
    return res.slice(0, limit);
  }
  const productItem = (p, attr) => `
    <div class="item" ${attr}="${esc(p.code)}">
      <div class="grow min0"><div class="name">${esc(p.name)}</div><div class="sub">${esc(p.code)} · ${esc(p.group)}${p.ref ? ' ⭐' : ''}</div></div>
      ${stockBadge(p.code)}
    </div>`;

  function renderProdResults() {
    const q = $('#prodSearch').value;
    if (!S.products.size && q) { $('#prodResults').innerHTML = '<div class="empty">Carga el inventario primero</div>'; return; }
    const res = searchProducts(q);
    $('#prodResults').innerHTML = q && !res.length ? '<div class="empty">Sin resultados</div>' : res.map(p => productItem(p, 'data-add')).join('');
  }

  /* ======================= Líneas ======================= */
  function renderLines() {
    const lines = S.draft.lines;
    const totalCar = lines.filter(l => l.unit === 'CAR').reduce((s, l) => s + (Number(l.qty) || 0), 0);
    $('#lineCount').textContent = lines.length ? `(${lines.length} · ${fmt(totalCar)} CAR)` : '';
    $('#orderNotes').value = S.draft.notes || '';
    $('#orderLines').innerHTML = lines.map((l, i) => {
      const p = S.products.get(l.code);
      const a = available(l.code);
      const warn = l.unit === 'CAR' && a !== null && Number(l.qty) > a ? `<div class="warn-text">⚠ Disp. ${fmt(a)}</div>` : '';
      return `
      <div class="line" data-i="${i}">
        <div class="top">
          <div class="grow min0"><div class="name">${esc(p?.name || l.name || l.code)}</div>
          <div class="sub small muted">#${esc(l.code)}</div>${warn}</div>
          <div class="row gap-xs">${stockBadge(l.code)}
            <button class="btn small ghost danger" data-del="${i}">✕</button></div>
        </div>
        <div class="controls">
          <div class="stepper">
            <button data-step="-1">−</button>
            <input type="number" inputmode="decimal" min="0" step="1" value="${esc(l.qty)}" data-f="qty">
            <button data-step="1">+</button>
          </div>
          <div class="unit-toggle">
            <button data-unit="CAR" class="${l.unit === 'CAR' ? 'on' : ''}">CAR</button>
            <button data-unit="UN" class="${l.unit === 'UN' ? 'on' : ''}">UN</button>
          </div>
          <label class="mini-label">Desc.<input class="mini" type="number" inputmode="decimal" value="${esc(l.discount)}" data-f="discount"></label>
          <label class="mini-label">Bonif.<input class="mini" type="number" inputmode="decimal" value="${esc(l.bonus)}" data-f="bonus"></label>
        </div>
      </div>`;
    }).join('');
  }

  async function finishOrder() {
    const c = clientById(S.draft.clientId);
    if (!c) { toast('Selecciona un cliente'); openClientPicker(); return; }
    const lines = S.draft.lines.filter(l => Number(l.qty) > 0).map(l => ({
      code: l.code, name: S.products.get(l.code)?.name || l.name || '', qty: Number(l.qty), unit: l.unit || 'CAR',
      discount: l.discount === '' ? '' : Number(l.discount), bonus: l.bonus === '' ? '' : Number(l.bonus),
    }));
    if (!lines.length) { toast('Agrega al menos 1 producto'); return; }
    if (!confirm(`¿Guardar pedido de ${c.name} (${lines.length} prod.)?`)) return;

    const now = new Date().toISOString();
    const order = {
      clientId: c.id, clientName: c.name, clientCode: c.code || '', clientAddress: c.address || '',
      date: S.draft.origDate || now, lines, notes: S.draft.notes || '',
      location: S.position ? { lat: S.position.lat, lng: S.position.lng, acc: Math.round(S.position.acc) } : null,
      distance: clientDist(c), autoClient: !!S.draft.autoClient,
      inventoryDate: S.inventory?.date || null, exportedAt: null,
    };
    if (S.draft.editingId) { order.id = S.draft.editingId; order.updatedAt = now; }
    const id = await DB.put('orders', order);
    S.draft = newDraft(); saveDraft();
    await computeCommitted();
    $('#prodSearch').value = ''; renderProdResults();
    renderLines(); renderClientCard(); showView('pedido');
    toast(`✔ Pedido #${id} guardado`);
    openOrderDetail(id);
  }

  /* ======================= Historial ======================= */
  async function filteredOrders() {
    const q = norm($('#histSearch').value).trim();
    const from = $('#histFrom').value, to = $('#histTo').value;
    return (await DB.all('orders')).filter(o => {
      const day = isoDay(o.date);
      if (from && day < from) return false;
      if (to && day > to) return false;
      if (q && !norm(`${o.clientName} ${o.clientCode} ${o.id}`).includes(q)) return false;
      return true;
    }).sort((a, b) => b.date.localeCompare(a.date));
  }

  async function renderHistory() {
    const orders = await filteredOrders();
    const ids = new Set(orders.map(o => o.id));
    [...S.selectedOrders].forEach(id => { if (!ids.has(id)) S.selectedOrders.delete(id); });
    if (!orders.length) { $('#histList').innerHTML = '<div class="empty">Sin pedidos</div>'; updateExportBtn(); return; }
    let html = '', lastDay = '';
    orders.forEach(o => {
      const day = isoDay(o.date);
      if (day !== lastDay) {
        const n = orders.filter(x => isoDay(x.date) === day).length;
        html += `<div class="date-head">${fmtDay(day)} · ${n}</div>`; lastDay = day;
      }
      const cajas = o.lines.filter(l => l.unit === 'CAR').reduce((s, l) => s + l.qty, 0);
      html += `
        <div class="card order-card">
          <input type="checkbox" data-sel="${o.id}" ${S.selectedOrders.has(o.id) ? 'checked' : ''}>
          <div class="grow" data-open="${o.id}">
            <div class="row between"><b class="truncate">${esc(o.clientName)}</b><span class="small muted">#${o.id} · ${fmtTime(o.date)}</span></div>
            <div class="small muted">${o.lines.length} ref. · ${fmt(cajas)} CAR
              ${o.exportedAt ? '<span class="tag ok">Excel</span>' : ''}${o.updatedAt ? '<span class="tag">Editado</span>' : ''}</div>
          </div>
        </div>`;
    });
    $('#histList').innerHTML = html;
    updateExportBtn();
  }
  function updateExportBtn() {
    const n = S.selectedOrders.size;
    $('#btnExportSel').textContent = n ? `⬇ Excel (${n})` : '⬇ Excel';
  }

  async function exportOrdersFlow(orders) {
    if (!orders.length) { toast('Sin pedidos'); return; }
    if (orders.length === 1) return doExport(orders, 'single');
    const body = openModal(`Exportar (${orders.length})`, `
      <button class="btn block primary" data-mode="sheets">Una hoja por pedido</button>
      <button class="btn block mt" data-mode="merge">Consolidado en una hoja</button>`);
    body.addEventListener('click', e => {
      const b = e.target.closest('[data-mode]');
      if (b) { closeModal(); doExport(orders, b.dataset.mode); }
    });
  }

  async function doExport(orders, mode, share = false) {
    try {
      toast('Generando…');
      const blob = await Excel.exportOrders(orders, mode);
      const day = isoDay(new Date());
      const name = orders.length === 1
        ? `Pedido_${orders[0].id}_${slug(orders[0].clientName)}_${isoDay(orders[0].date)}.xlsx`
        : `Pedidos_${mode === 'merge' ? 'consolidado_' : ''}${day}_${orders.length}.xlsx`;
      if (share) await shareBlob(blob, name, 'Pedido'); else downloadBlob(blob, name);
      const now = new Date().toISOString();
      await DB.putMany('orders', orders.map(o => ({ ...o, exportedAt: now })));
      toast(`✔ ${name}`);
      if ($('#view-historial').classList.contains('active')) renderHistory();
    } catch (e) { console.error(e); alert('Error: ' + e.message); }
  }

  async function openOrderDetail(id) {
    const o = await DB.get('orders', id);
    if (!o) return;
    const c = clientById(o.clientId);
    const rows = o.lines.map(l => `<tr><td>${esc(l.code)}</td><td>${esc(l.name)}</td><td class="num">${fmt(l.qty)}</td><td>${esc(l.unit)}</td>
      <td class="num">${l.discount !== '' && l.discount != null ? fmt(l.discount) : ''}</td><td class="num">${l.bonus !== '' && l.bonus != null ? fmt(l.bonus) : ''}</td></tr>`).join('');
    const loc = o.location ? ` · <a href="https://maps.google.com/?q=${o.location.lat},${o.location.lng}" target="_blank" rel="noopener">Mapa</a>` : '';
    const body = openModal(`Pedido #${o.id}`, `
      <div><b>${esc(o.clientName)}</b> ${o.clientCode ? `<span class="muted small">#${esc(o.clientCode)}</span>` : ''}</div>
      <div class="small muted">${fmtDay(isoDay(o.date))} ${fmtTime(o.date)}${loc}</div>
      <div class="table-wrap"><table class="detail"><thead><tr><th>Cód</th><th>Producto</th><th class="num">Cant</th><th>UM</th><th class="num">Desc</th><th class="num">Bon</th></tr></thead><tbody>${rows}</tbody></table></div>
      ${o.notes ? `<p class="small"><b>Obs.:</b> ${esc(o.notes)}</p>` : ''}
      <div class="grid-2 mt">
        <button class="btn primary" data-a="export">⬇ Excel</button>
        <button class="btn" data-a="share">📤 Compartir</button>
        <button class="btn" data-a="edit">✏ Editar</button>
        <button class="btn" data-a="dup">⧉ Repetir</button>
        ${c ? '<button class="btn" data-a="saveList">📋 Fijar lista</button>' : ''}
        <button class="btn danger" data-a="del">🗑 Eliminar</button>
      </div>`);
    body.addEventListener('click', async e => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (!a) return;
      if (a === 'export') doExport([o], 'single');
      if (a === 'share') doExport([o], 'single', true);
      if (a === 'edit' || a === 'dup') {
        if (S.draft.lines.length && !confirm('¿Reemplazar el pedido actual?')) return;
        S.draft = { ...newDraft(), clientId: o.clientId, lines: o.lines.map(l => ({ ...l })), notes: o.notes,
          editingId: a === 'edit' ? o.id : null, origDate: a === 'edit' ? o.date : null };
        saveDraft(); await computeCommitted(); closeModal(); renderLines(); renderClientCard(); showView('pedido');
      }
      if (a === 'saveList' && c) {
        if (c.products?.length && !confirm(`¿Reemplazar lista de ${c.name}?`)) return;
        c.products = o.lines.map(l => ({ code: l.code, name: l.name, qty: l.qty, unit: l.unit, discount: l.discount }));
        await DB.put('clients', c); toast('Lista guardada');
      }
      if (a === 'del' && confirm(`¿Eliminar pedido #${o.id}?`)) {
        await DB.del('orders', o.id); await computeCommitted(); closeModal(); renderHistory(); toast('Eliminado');
      }
    });
  }

  /* ======================= Clientes ======================= */
  function renderClients() {
    const q = norm($('#cliSearch').value).trim().split(/\s+/).filter(Boolean);
    const list = S.clients.filter(c => q.every(w => norm(`${c.name} ${c.code} ${c.address}`).includes(w)))
      .sort((a, b) => a.name.localeCompare(b.name));
    $('#cliList').innerHTML = list.length ? `<div class="card">${list.map(c => `
      <div class="item" data-edit="${c.id}">
        <div class="grow min0"><div class="name truncate">${esc(c.name)}</div>
        <div class="sub truncate">${esc([c.code, c.address].filter(Boolean).join(' · '))}</div></div>
        <div class="small muted">${hasCoords(c) ? '📍' : ''} ${c.products?.length || ''}</div>
      </div>`).join('')}</div>` : '<div class="empty">Sin clientes</div>';
  }

  function openClientEditor(id, opts = {}) {
    const orig = id ? clientById(id) : null;
    const c = orig ? JSON.parse(JSON.stringify(orig)) : { code: '', name: '', address: '', phone: '', lat: null, lng: null, radius: null, products: [] };
    if (!orig && opts.useHere && S.position) { c.lat = S.position.lat; c.lng = S.position.lng; }
    c.products = c.products || [];

    const body = openModal(orig ? 'Cliente' : 'Nuevo cliente', `
      <label class="field">Nombre *<input id="ceName" value="${esc(c.name)}"></label>
      <div class="grid-2">
        <label class="field">Código / NIT<input id="ceCode" value="${esc(c.code)}"></label>
        <label class="field">Teléfono<input id="cePhone" type="tel" value="${esc(c.phone)}"></label>
      </div>
      <label class="field">Dirección<input id="ceAddr" value="${esc(c.address)}"></label>
      <div class="row gap-xs">
        <label class="field grow">Latitud<input id="ceLat" type="number" step="any" inputmode="decimal" value="${c.lat ?? ''}"></label>
        <label class="field grow">Longitud<input id="ceLng" type="number" step="any" inputmode="decimal" value="${c.lng ?? ''}"></label>
        <label class="field" style="width:4.8rem">Radio<input id="ceRad" type="number" inputmode="numeric" placeholder="${S.settings.radius}" value="${c.radius ?? ''}"></label>
      </div>
      <div class="grid-2">
        <button class="btn small" id="ceHere">📍 Mi ubicación</button>
        <a class="btn small" id="ceMap" target="_blank" rel="noopener">🗺 Mapa</a>
      </div>
      <h2 class="mt">Lista habitual</h2>
      <input type="search" id="ceSearch" placeholder="🔍 Agregar producto…" autocomplete="off">
      <div id="ceResults" class="results"></div>
      <div id="ceList" class="mt"></div>
      <div class="row gap-s wrap mt">
        <button class="btn primary grow" id="ceSave">Guardar</button>
        ${orig ? '<button class="btn" id="ceOrder">🛒 Pedido</button><button class="btn danger" id="ceDel">🗑</button>' : ''}
      </div>`);

    const updMap = () => {
      const lat = $('#ceLat', body).value, lng = $('#ceLng', body).value;
      const a = $('#ceMap', body);
      a.href = lat && lng ? `https://maps.google.com/?q=${lat},${lng}` : `https://maps.google.com/?q=${encodeURIComponent($('#ceAddr', body).value)}`;
    };
    const renderList = () => {
      $('#ceList', body).innerHTML = c.products.length ? c.products.map((p, i) => `
        <div class="item" style="cursor:default">
          <div class="grow min0"><div class="name truncate">${esc(S.products.get(p.code)?.name || p.name || p.code)}</div><div class="sub">#${esc(p.code)}</div></div>
          <input class="mini" style="width:3.8rem" type="number" inputmode="decimal" value="${esc(p.qty)}" data-lq="${i}">
          <select class="mini" style="width:4.2rem" data-lu="${i}"><option ${p.unit !== 'UN' ? 'selected' : ''}>CAR</option><option ${p.unit === 'UN' ? 'selected' : ''}>UN</option></select>
          <button class="btn small ghost danger" data-lr="${i}">✕</button>
        </div>`).join('') : '<div class="small muted">Vacía</div>';
    };
    updMap(); renderList();

    $('#ceLat', body).addEventListener('input', updMap);
    $('#ceLng', body).addEventListener('input', updMap);
    $('#ceAddr', body).addEventListener('input', updMap);
    $('#ceSearch', body).addEventListener('input', debounce(() => {
      const res = searchProducts($('#ceSearch', body).value, 25);
      $('#ceResults', body).innerHTML = res.map(p => productItem(p, 'data-ceadd')).join('');
    }, 120));
    body.addEventListener('input', e => {
      if (e.target.dataset.lq !== undefined) c.products[e.target.dataset.lq].qty = parseFloat(e.target.value) || 0;
    });
    body.addEventListener('change', e => {
      if (e.target.dataset.lu !== undefined) c.products[e.target.dataset.lu].unit = e.target.value;
    });
    body.addEventListener('click', async e => {
      const t = e.target;
      const add = t.closest('[data-ceadd]');
      if (add) {
        const code = add.dataset.ceadd;
        if (!c.products.some(p => p.code === code)) c.products.push({ code, name: S.products.get(code)?.name || '', qty: 1, unit: 'CAR' });
        $('#ceSearch', body).value = ''; $('#ceResults', body).innerHTML = ''; renderList(); return;
      }
      if (t.dataset.lr !== undefined) { c.products.splice(Number(t.dataset.lr), 1); renderList(); return; }
      if (t.id === 'ceHere') {
        t.textContent = 'Ubicando…';
        navigator.geolocation.getCurrentPosition(pos => {
          S.position = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy, at: Date.now() };
          $('#ceLat', body).value = pos.coords.latitude.toFixed(6); $('#ceLng', body).value = pos.coords.longitude.toFixed(6);
          t.textContent = `📍 ±${Math.round(pos.coords.accuracy)} m`; updMap();
        }, () => { t.textContent = '📍 Mi ubicación'; toast('Sin GPS'); }, { enableHighAccuracy: true, timeout: 15000 });
      }
      if (t.id === 'ceSave') {
        const name = $('#ceName', body).value.trim();
        if (!name) { toast('Falta el nombre'); return; }
        const pf = (v) => (v === '' ? null : parseFloat(v));
        Object.assign(c, {
          name, code: $('#ceCode', body).value.trim(), phone: $('#cePhone', body).value.trim(), address: $('#ceAddr', body).value.trim(),
          lat: pf($('#ceLat', body).value), lng: pf($('#ceLng', body).value), radius: pf($('#ceRad', body).value),
        });
        const newId = await DB.put('clients', c);
        S.clients = await DB.all('clients');
        closeModal(); toast('Guardado');
        if (opts.selectAfter) setClient(newId, false, null);
        renderClients(); renderClientCard();
      }
      if (t.id === 'ceDel' && confirm(`¿Eliminar ${orig.name}?`)) {
        await DB.del('clients', orig.id); S.clients = await DB.all('clients');
        if (S.draft.clientId === orig.id) { S.draft.clientId = null; saveDraft(); }
        closeModal(); renderClients(); renderClientCard(); toast('Eliminado');
      }
      if (t.id === 'ceOrder') {
        closeModal();
        if (S.draft.lines.length && S.draft.clientId !== orig.id && !confirm('¿Cambiar cliente del pedido actual?')) return;
        setClient(orig.id, false, null); showView('pedido');
      }
    });
  }

  async function importClientsFile(file) {
    try {
      const list = await Excel.parseClients(file);
      let added = 0, updated = 0;
      for (const n of list) {
        const ex = S.clients.find(c => (n.code && c.code === n.code) || (!n.code && norm(c.name) === norm(n.name)));
        if (ex) {
          Object.assign(ex, Object.fromEntries(Object.entries(n).filter(([, v]) => v !== null && v !== '' && !(Array.isArray(v) && !v.length))));
          await DB.put('clients', ex); updated++;
        } else { await DB.put('clients', n); added++; }
      }
      S.clients = await DB.all('clients');
      renderClients(); renderClientCard();
      toast(`✔ +${added} nuevos · ${updated} act.`);
      if (S.position) autoDetectClient(false);
    } catch (e) { alert(e.message); }
  }

  /* ======================= Inventario ======================= */
  async function importInventoryFile(file, fileName) {
    fileName = fileName || file.name || '';
    try {
      toast('Cargando…', 10000);
      const r = await Excel.parseInventory(file, fileName);
      const date = isoDay(r.date);
      if (S.inventory && date < S.inventory.date &&
        !confirm(`Archivo del ${fmtDay(date)} (anterior al ${fmtDay(S.inventory.date)}). ¿Reemplazar?`)) { toast(''); return; }
      await DB.replaceAll('products', r.products);
      S.inventory = { date, fileName, importedAt: new Date().toISOString(), count: r.products.length, sheet: r.sheet, refCount: r.refCount };
      await DB.setMeta('inventory', S.inventory);
      S.products = new Map(r.products.map(p => [p.code, p]));
      await computeCommitted();
      renderHeader(); renderInventory(); renderLines(); renderProdResults();
      toast(`✔ Inv. ${fmtDay(date)} (${r.products.length})`, 3000);
      return true;
    } catch (e) {
      console.error(e); toast('');
      throw e;
    }
  }

  function renderInventory() {
    const inv = S.inventory;
    $('#invSummary').innerHTML = inv
      ? `<b>${fmtDay(inv.date)}</b> · ${fmt(inv.count)} prod. · ${fmt(inv.refCount || 0)} ⭐<div class="muted">${esc(inv.fileName)}</div>`
      : 'Sin inventario cargado';
    const q = norm($('#invSearch').value).trim();
    const f = $('#invFilter').value;
    let list = q ? searchProducts(q, 200) : [...S.products.values()].sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
    if (f === 'ref') list = list.filter(p => p.ref);
    if (f === 'stock') list = list.filter(p => available(p.code) > 0);
    const total = list.length;
    $('#invList').innerHTML = list.slice(0, 150).map(p => `
      <div class="item" style="cursor:default">
        <div class="grow min0"><div class="name">${esc(p.name)}</div>
        <div class="sub">#${esc(p.code)} · Stock ${fmt(p.stock)} · Trán. ${fmt(p.transito)} · Pend. ${fmt(p.pendiente)}${S.committed.get(p.code) ? ` · Ped. ${fmt(S.committed.get(p.code))}` : ''}</div></div>
        ${stockBadge(p.code)}
      </div>`).join('') + (total > 150 ? `<div class="empty">150 de ${total}</div>` : '');
  }

  /* ======================= Ajustes ======================= */
  async function renderSettings() {
    $('#setRadius').value = S.settings.radius;
    $('#setDeduct').checked = !!S.settings.deduct;
    applyTheme();
    const orders = await DB.all('orders');
    $('#stats').textContent = `${S.products.size} productos · ${S.clients.length} clientes · ${orders.length} pedidos`;
  }
  async function saveSettings() {
    S.settings.radius = Number($('#setRadius').value) || 150;
    S.settings.deduct = $('#setDeduct').checked;
    await DB.setMeta('settings', S.settings);
    applyTheme();
  }
  async function backup() {
    const data = {
      app: 'pedidos-colombina', version: 1, exportedAt: new Date().toISOString(),
      products: await DB.all('products'), clients: await DB.all('clients'), orders: await DB.all('orders'), meta: await DB.all('meta'),
    };
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    await shareBlob(blob, `respaldo_pedidos_${isoDay(new Date())}.json`, 'Respaldo');
  }
  async function restore(file) {
    try {
      const data = JSON.parse(await file.text());
      if (data.app !== 'pedidos-colombina') throw new Error('Archivo inválido');
      if (!confirm(`¿Restaurar copia del ${fmtDay(isoDay(data.exportedAt))} (${data.orders.length} pedidos)?`)) return;
      await DB.replaceAll('products', data.products); await DB.replaceAll('clients', data.clients);
      await DB.replaceAll('orders', data.orders); await DB.replaceAll('meta', data.meta);
      await loadAll(); renderAll(); toast('Restaurado');
    } catch (e) { alert('Error: ' + e.message); }
  }

  /* ======================= Archivo compartido ======================= */
  async function handleSharedFile() {
    const params = new URLSearchParams(location.search);
    if (!params.has('shared')) return;
    history.replaceState(null, '', location.pathname);
    try {
      const cache = await caches.open('shared-files');
      const res = await cache.match('shared-file');
      if (!res) return;
      const name = decodeURIComponent(res.headers.get('X-Filename') || 'archivo.xlsx');
      const blob = await res.blob();
      await cache.delete('shared-file');
      try { await importInventoryFile(blob, name); showView('inventario'); }
      catch {
        if (confirm(`¿Importar "${name}" como clientes?`)) { await importClientsFile(blob); showView('clientes'); }
      }
    } catch (e) { console.error(e); }
  }

  /* ======================= Eventos ======================= */
  function bindEvents() {
    $$('.tabbar button').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));
    document.addEventListener('click', e => { const g = e.target.closest('[data-go]'); if (g) showView(g.dataset.go); });
    $('#modalClose').addEventListener('click', closeModal);
    $('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });

    // Tema rápido y selector en ajustes
    $('#btnTheme').addEventListener('click', () => {
      S.settings.theme = isDark() ? 'light' : 'dark';
      saveSettings();
    });
    $('#themeSeg').addEventListener('click', e => {
      const b = e.target.closest('[data-theme]');
      if (b) { S.settings.theme = b.dataset.theme; saveSettings(); }
    });

    // Pedido
    $('#btnPickClient').addEventListener('click', openClientPicker);
    $('#btnLocate').addEventListener('click', () => locate(true));
    $('#nearbyList').addEventListener('click', e => { const ch = e.target.closest('[data-client]'); if (ch) setClient(Number(ch.dataset.client), false, null); });
    $('#clientActions').addEventListener('click', async e => {
      const a = e.target.closest('[data-act]')?.dataset.act;
      const c = clientById(S.draft.clientId);
      if (a === 'loadList' && c) loadClientList(c);
      if (a === 'saveLoc' && c && S.position) {
        c.lat = S.position.lat; c.lng = S.position.lng; await DB.put('clients', c);
        toast('📍 Ubicación guardada'); renderClientCard();
      }
      if (a === 'newClientHere') openClientEditor(null, { useHere: true, selectAfter: true });
      if (a === 'cancelEdit' && confirm('¿Cancelar edición?')) {
        S.draft = newDraft(); saveDraft(); await computeCommitted(); renderLines(); renderClientCard(); showView('pedido'); locate();
      }
    });
    $('#prodSearch').addEventListener('input', debounce(renderProdResults, 120));
    $('#prodResults').addEventListener('click', e => {
      const it = e.target.closest('[data-add]');
      if (it) { addLine(it.dataset.add); $('#prodSearch').value = ''; renderProdResults(); }
    });
    const lines = $('#orderLines');
    lines.addEventListener('click', e => {
      const line = e.target.closest('.line'); if (!line) return;
      const l = S.draft.lines[Number(line.dataset.i)];
      if (e.target.dataset.del !== undefined) { S.draft.lines.splice(Number(line.dataset.i), 1); saveDraft(); renderLines(); return; }
      if (e.target.dataset.step) { l.qty = Math.max(0, (Number(l.qty) || 0) + Number(e.target.dataset.step)); saveDraft(); renderLines(); }
      if (e.target.dataset.unit) { l.unit = e.target.dataset.unit; saveDraft(); renderLines(); }
    });
    lines.addEventListener('input', e => {
      const f = e.target.dataset.f; if (!f) return;
      const l = S.draft.lines[Number(e.target.closest('.line').dataset.i)];
      l[f] = e.target.value === '' ? '' : parseFloat(e.target.value);
      saveDraft();
    });
    lines.addEventListener('change', e => { if (e.target.dataset.f) renderLines(); });
    $('#orderNotes').addEventListener('input', e => { S.draft.notes = e.target.value; saveDraft(); });
    $('#btnClearOrder').addEventListener('click', () => {
      if (S.draft.lines.length && confirm('¿Vaciar pedido?')) { S.draft.lines = []; saveDraft(); renderLines(); }
    });
    $('#btnFinish').addEventListener('click', finishOrder);

    // Historial
    const rh = debounce(renderHistory, 150);
    ['#histSearch', '#histFrom', '#histTo'].forEach(s => $(s).addEventListener('input', rh));
    $('#btnHistToday').addEventListener('click', () => { const d = isoDay(new Date()); $('#histFrom').value = d; $('#histTo').value = d; renderHistory(); });
    $('#btnHistAll').addEventListener('click', () => { $('#histFrom').value = ''; $('#histTo').value = ''; $('#histSearch').value = ''; renderHistory(); });
    $('#btnSelAll').addEventListener('click', async () => {
      const orders = await filteredOrders();
      const all = orders.every(o => S.selectedOrders.has(o.id));
      orders.forEach(o => (all ? S.selectedOrders.delete(o.id) : S.selectedOrders.add(o.id)));
      renderHistory();
    });
    $('#histList').addEventListener('click', e => {
      const sel = e.target.closest('[data-sel]');
      if (sel) { const id = Number(sel.dataset.sel); sel.checked ? S.selectedOrders.add(id) : S.selectedOrders.delete(id); updateExportBtn(); return; }
      const op = e.target.closest('[data-open]'); if (op) openOrderDetail(Number(op.dataset.open));
    });
    $('#btnExportSel').addEventListener('click', async () => {
      const orders = await filteredOrders();
      const chosen = S.selectedOrders.size ? orders.filter(o => S.selectedOrders.has(o.id)) : orders;
      if (!S.selectedOrders.size && chosen.length && !confirm(`¿Exportar los ${chosen.length} pedidos?`)) return;
      exportOrdersFlow(chosen.slice().reverse());
    });

    // Clientes
    $('#cliSearch').addEventListener('input', debounce(renderClients, 120));
    $('#btnNewClient').addEventListener('click', () => openClientEditor(null, { useHere: false }));
    $('#cliList').addEventListener('click', e => { const it = e.target.closest('[data-edit]'); if (it) openClientEditor(Number(it.dataset.edit)); });
    $('#cliImport').addEventListener('change', async e => { const f = e.target.files[0]; e.target.value = ''; if (f) importClientsFile(f); });
    $('#btnCliExport').addEventListener('click', async () => downloadBlob(await Excel.exportClients(S.clients), `Clientes_${isoDay(new Date())}.xlsx`));

    // Inventario
    $('#invFile').addEventListener('change', async e => {
      const f = e.target.files[0]; e.target.value = '';
      if (f) try { await importInventoryFile(f); } catch (err) { alert('Error: ' + err.message); }
    });
    $('#invSearch').addEventListener('input', debounce(renderInventory, 150));
    $('#invFilter').addEventListener('change', renderInventory);

    // Más
    $('#setRadius').addEventListener('change', () => { saveSettings(); toast('Guardado'); });
    $('#setDeduct').addEventListener('change', async () => { await saveSettings(); renderLines(); });
    $('#btnBackup').addEventListener('click', backup);
    $('#restoreFile').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) restore(f); });
    window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); S.installEvt = e; $('#btnInstall').hidden = false; });
    $('#btnInstall').addEventListener('click', async () => { if (S.installEvt) { S.installEvt.prompt(); S.installEvt = null; $('#btnInstall').hidden = true; } });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && !S.draft.lines.length && (!S.position || Date.now() - S.position.at > 60000)) locate();
    });
  }

  function renderAll() { renderHeader(); renderClientCard(); renderLines(); renderProdResults(); }

  async function init() {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW', err));
    if (navigator.storage?.persist) navigator.storage.persist();
    loadDraft();
    await loadAll();
    if (!S.inventory) {
      try {
        const res = await fetch('assets/inventario_inicial.xlsx');
        if (res.ok) await importInventoryFile(await res.blob(), 'Inventario 06-11-26.xlsx');
      } catch {}
    }
    bindEvents();
    renderAll();
    await handleSharedFile();
    locate();
  }
  init();
})();
