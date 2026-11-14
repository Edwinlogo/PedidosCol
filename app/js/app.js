/* Pedidos Colombina - lógica principal */
(() => {
  'use strict';

  /* ======================= Estado ======================= */
  const S = {
    products: new Map(),      // code -> producto
    clients: [],              // lista de clientes
    inventory: null,          // {date, fileName, importedAt, count, sheet}
    settings: { radius: 150, deduct: true },
    committed: new Map(),     // code -> cajas comprometidas en pedidos posteriores al inventario
    position: null,           // {lat, lng, acc, at}
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
  const fmtTime = (iso) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const fmtDist = (m) => (m == null ? '' : m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);
  const debounce = (fn, ms = 150) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  function toast(msg, ms = 2600) {
    const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
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

  /* ======================= Carga de datos ======================= */
  async function loadAll() {
    const [products, clients, inv, settings] = await Promise.all([
      DB.all('products'), DB.all('clients'), DB.getMeta('inventory'), DB.getMeta('settings'),
    ]);
    S.products = new Map(products.map(p => [p.code, p]));
    S.clients = clients;
    S.inventory = inv;
    S.settings = { ...S.settings, ...(settings || {}) };
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
    if (a === null) return '<span class="stock none">No está en inventario</span>';
    const cls = a <= 0 ? 'none' : a < 5 ? 'low' : '';
    return `<span class="stock ${cls}">Disp. ${fmt(a)}</span>`;
  }

  /* ======================= Navegación ======================= */
  const TITLES = { pedido: 'Nuevo pedido', historial: 'Pedidos realizados', clientes: 'Clientes', inventario: 'Inventario', mas: 'Más opciones' };
  function showView(name) {
    $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${name}`));
    $$('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.view === name));
    $('#viewTitle').textContent = name === 'pedido' && S.draft?.editingId ? `Editando pedido #${S.draft.editingId}` : TITLES[name];
    if (name === 'historial') renderHistory();
    if (name === 'clientes') renderClients();
    if (name === 'inventario') renderInventory();
    if (name === 'mas') renderSettings();
    window.scrollTo(0, 0);
  }

  function renderHeader() {
    const inv = S.inventory;
    $('#invBadge').textContent = inv ? `Inv. ${fmtDay(inv.date)}` : 'Sin inventario';
    const banner = $('#banner');
    const today = isoDay(new Date());
    if (!inv) {
      banner.innerHTML = '⚠ No hay inventario cargado. <button class="btn small" data-go="inventario">Cargar inventario</button>';
      banner.classList.remove('hidden');
    } else if (inv.date < today) {
      banner.innerHTML = `⚠ El inventario es del <b>${fmtDay(inv.date)}</b>. ¿Ya recibiste el de hoy? <button class="btn small" data-go="inventario">Actualizar</button>`;
      banner.classList.remove('hidden');
    } else banner.classList.add('hidden');
  }

  /* ======================= Borrador de pedido ======================= */
  function newDraft() { return { clientId: null, autoClient: false, distance: null, lines: [], notes: '', editingId: null, origDate: null }; }
  function saveDraft() { localStorage.setItem('draft', JSON.stringify(S.draft)); }
  function loadDraft() {
    try { S.draft = JSON.parse(localStorage.getItem('draft')) || newDraft(); } catch { S.draft = newDraft(); }
  }

  function setClient(id, auto = false, distance = null) {
    const changed = S.draft.clientId !== id;
    S.draft.clientId = id; S.draft.autoClient = auto; S.draft.distance = distance;
    const c = clientById(id);
    // Si el pedido está vacío, precargar la lista habitual del cliente
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
    if (!silent || added) toast(`Lista habitual cargada: ${added} productos`);
  }

  function addLine(code) {
    const p = S.products.get(code);
    const ex = S.draft.lines.find(l => l.code === code);
    if (ex) { ex.qty = (Number(ex.qty) || 0) + 1; toast(`${p?.name || code}: ${fmt(ex.qty)}`); }
    else { S.draft.lines.unshift({ code, name: p?.name || '', qty: 1, unit: 'CAR', discount: '', bonus: '' }); toast('Producto agregado'); }
    saveDraft(); renderLines();
  }

  /* ======================= Ubicación ======================= */
  function locate(manual = false) {
    const st = $('#clientStatus');
    if (!('geolocation' in navigator)) { st.textContent = 'Este dispositivo no permite ubicación'; return; }
    st.textContent = 'Detectando ubicación…';
    navigator.geolocation.getCurrentPosition(pos => {
      S.position = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy, at: Date.now() };
      autoDetectClient(manual);
    }, err => {
      S.position = null;
      const msg = err.code === 1 ? 'Permiso de ubicación denegado. Selecciona el cliente manualmente.'
        : 'No se pudo obtener la ubicación. Selecciona el cliente manualmente.';
      renderClientCard(msg);
    }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 });
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
      const tol = Math.min(S.position.acc || 0, 100); // tolerancia por precisión del GPS
      if (near.d <= radius + tol && canAuto && !S.draft.editingId) {
        if (S.draft.clientId !== near.c.id) toast(`Cliente detectado: ${near.c.name}`);
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
      st.textContent = S.draft.autoClient ? `📍 Detectado por ubicación${d != null ? ' · a ' + fmtDist(d) : ''}`
        : `Seleccionado manualmente${d != null ? ' · a ' + fmtDist(d) : ''}`;
      nm.textContent = c.name;
      info.textContent = [c.code && `Cód. ${c.code}`, c.address].filter(Boolean).join(' · ');
    } else {
      st.textContent = errMsg || (S.position ? `Ningún cliente registrado cerca (precisión ${Math.round(S.position.acc)} m)` : 'Sin ubicación');
      nm.textContent = 'Selecciona un cliente';
      info.textContent = '';
    }
    if (errMsg && c) st.textContent += ' · ' + errMsg;

    // Clientes cercanos para cambio rápido
    const near = nearestClients(4).filter(x => x.c.id !== S.draft.clientId);
    $('#nearbyList').innerHTML = near.map(x => `<span class="chip" data-client="${x.c.id}">${esc(x.c.name)} · ${fmtDist(x.d)}</span>`).join('');

    const acts = [];
    if (c?.products?.length) acts.push(`<button class="btn small" data-act="loadList">📋 Cargar lista habitual (${c.products.length})</button>`);
    if (c && S.position && !hasCoords(c)) acts.push('<button class="btn small" data-act="saveLoc">📍 Guardar esta ubicación para el cliente</button>');
    if (!c && S.position) acts.push('<button class="btn small" data-act="newClientHere">+ Registrar cliente en esta ubicación</button>');
    if (S.draft.editingId) acts.push(`<button class="btn small danger" data-act="cancelEdit">Cancelar edición #${S.draft.editingId}</button>`);
    $('#clientActions').innerHTML = acts.join('');
  }

  function openClientPicker() {
    const body = openModal('Seleccionar cliente', `
      <input type="search" id="pickSearch" placeholder="Buscar por nombre, código o dirección…" autocomplete="off">
      <div id="pickList" class="mt"></div>
      <button class="btn block mt" id="pickNew">+ Nuevo cliente</button>`);
    const render = () => {
      const q = norm($('#pickSearch', body).value).trim().split(/\s+/).filter(Boolean);
      const list = S.clients
        .filter(c => q.every(w => norm(`${c.name} ${c.code} ${c.address}`).includes(w)))
        .map(c => ({ c, d: clientDist(c) }))
        .sort((a, b) => (a.d ?? 1e12) - (b.d ?? 1e12) || a.c.name.localeCompare(b.c.name));
      $('#pickList', body).innerHTML = list.length ? list.slice(0, 100).map(({ c, d }) => `
        <div class="item" data-pick="${c.id}">
          <div><div class="name">${esc(c.name)}</div><div class="sub">${esc([c.code, c.address].filter(Boolean).join(' · '))}</div></div>
          <span class="small muted">${d != null ? fmtDist(d) : hasCoords(c) ? '' : 'sin ubicación'}</span>
        </div>`).join('') : '<div class="empty">No hay clientes. Crea uno nuevo o impórtalos desde Excel en la pestaña Clientes.</div>';
    };
    $('#pickSearch', body).addEventListener('input', debounce(render, 100));
    body.addEventListener('click', e => {
      const it = e.target.closest('[data-pick]');
      if (it) { setClient(Number(it.dataset.pick), false, null); closeModal(); }
      if (e.target.id === 'pickNew') openClientEditor(null, { useHere: true, selectAfter: true });
    });
    render();
  }

  /* ======================= Búsqueda de productos ======================= */
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
      <div class="grow"><div class="name">${esc(p.name)}</div><div class="sub">${esc(p.code)} · ${esc(p.group)}${p.ref ? ' · ⭐' : ''}</div></div>
      ${stockBadge(p.code)}
    </div>`;

  function renderProdResults() {
    const q = $('#prodSearch').value;
    if (!S.products.size && q) { $('#prodResults').innerHTML = '<div class="empty">Primero carga el inventario.</div>'; return; }
    const res = searchProducts(q);
    $('#prodResults').innerHTML = q && !res.length ? '<div class="empty">Sin resultados</div>' : res.map(p => productItem(p, 'data-add')).join('');
  }

  /* ======================= Líneas del pedido ======================= */
  function renderLines() {
    const lines = S.draft.lines;
    const totalCar = lines.filter(l => l.unit === 'CAR').reduce((s, l) => s + (Number(l.qty) || 0), 0);
    $('#lineCount').textContent = lines.length ? `(${lines.length} ref. · ${fmt(totalCar)} cajas)` : '';
    $('#orderNotes').value = S.draft.notes || '';
    $('#orderLines').innerHTML = lines.map((l, i) => {
      const p = S.products.get(l.code);
      const a = available(l.code);
      const warn = l.unit === 'CAR' && a !== null && Number(l.qty) > a ? `<div class="warn-text">⚠ Supera el disponible (${fmt(a)})</div>` : '';
      return `
      <div class="line" data-i="${i}">
        <div class="top">
          <div><div class="name">${esc(p?.name || l.name || 'Producto ' + l.code)}</div>
          <div class="sub small muted">${esc(l.code)}</div>${warn}</div>
          <div class="col" style="align-items:flex-end;gap:.3rem">${stockBadge(l.code)}
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
    if (!c) { toast('Selecciona el cliente antes de finalizar'); openClientPicker(); return; }
    const lines = S.draft.lines.filter(l => Number(l.qty) > 0).map(l => ({
      code: l.code, name: S.products.get(l.code)?.name || l.name || '', qty: Number(l.qty), unit: l.unit || 'CAR',
      discount: l.discount === '' ? '' : Number(l.discount), bonus: l.bonus === '' ? '' : Number(l.bonus),
    }));
    if (!lines.length) { toast('El pedido no tiene productos con cantidad'); return; }
    const removed = S.draft.lines.length - lines.length;
    const msg = `¿Finalizar pedido para ${c.name}?\n${lines.length} productos${removed ? ` (se omiten ${removed} con cantidad 0)` : ''}.`;
    if (!confirm(msg)) return;

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
    toast(`Pedido #${id} guardado ✔`);
    openOrderDetail(id, true);
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
    if (!orders.length) { $('#histList').innerHTML = '<div class="empty">No hay pedidos para este filtro.</div>'; updateExportBtn(); return; }
    let html = '', lastDay = '';
    orders.forEach(o => {
      const day = isoDay(o.date);
      if (day !== lastDay) {
        const n = orders.filter(x => isoDay(x.date) === day).length;
        html += `<div class="date-head">${fmtDay(day)} · ${n} pedido${n > 1 ? 's' : ''}</div>`; lastDay = day;
      }
      const cajas = o.lines.filter(l => l.unit === 'CAR').reduce((s, l) => s + l.qty, 0);
      html += `
        <div class="card order-card">
          <input type="checkbox" data-sel="${o.id}" ${S.selectedOrders.has(o.id) ? 'checked' : ''} style="margin-top:.3rem">
          <div class="grow" data-open="${o.id}">
            <div class="row between"><b>${esc(o.clientName)}</b><span class="small muted">#${o.id} · ${fmtTime(o.date)}</span></div>
            <div class="small muted">${o.lines.length} ref. · ${fmt(cajas)} cajas
              ${o.exportedAt ? '<span class="tag ok">Exportado</span>' : ''}${o.updatedAt ? '<span class="tag">Editado</span>' : ''}</div>
          </div>
        </div>`;
    });
    $('#histList').innerHTML = html;
    updateExportBtn();
  }
  function updateExportBtn() {
    const n = S.selectedOrders.size;
    $('#btnExportSel').textContent = n ? `⬇ Exportar ${n} seleccionado${n > 1 ? 's' : ''}` : '⬇ Exportar Excel';
  }

  async function exportOrdersFlow(orders) {
    if (!orders.length) { toast('No hay pedidos para exportar'); return; }
    if (orders.length === 1) return doExport(orders, 'single');
    const body = openModal(`Exportar ${orders.length} pedidos`, `
      <p class="small muted">Se generará un archivo con el formato de <b>Plantillas.xlsx</b>.</p>
      <button class="btn block primary" data-mode="sheets">Una hoja por pedido</button>
      <button class="btn block mt" data-mode="merge">Consolidado (sumar cantidades por código)</button>`);
    body.addEventListener('click', e => {
      const b = e.target.closest('[data-mode]');
      if (b) { closeModal(); doExport(orders, b.dataset.mode); }
    });
  }

  async function doExport(orders, mode, share = false) {
    try {
      toast('Generando Excel…');
      const blob = await Excel.exportOrders(orders, mode);
      const day = isoDay(new Date());
      const name = orders.length === 1
        ? `Pedido_${orders[0].id}_${slug(orders[0].clientName)}_${isoDay(orders[0].date)}.xlsx`
        : `Pedidos_${mode === 'merge' ? 'consolidado_' : ''}${day}_${orders.length}.xlsx`;
      if (share) await shareBlob(blob, name, 'Pedido'); else downloadBlob(blob, name);
      const now = new Date().toISOString();
      await DB.putMany('orders', orders.map(o => ({ ...o, exportedAt: now })));
      toast(`Archivo generado: ${name}`);
      if ($('#view-historial').classList.contains('active')) renderHistory();
    } catch (e) { console.error(e); alert('Error al generar el Excel: ' + e.message); }
  }

  async function openOrderDetail(id, justSaved = false) {
    const o = await DB.get('orders', id);
    if (!o) return;
    const c = clientById(o.clientId);
    const rows = o.lines.map(l => `<tr><td>${esc(l.code)}</td><td>${esc(l.name)}</td><td class="num">${fmt(l.qty)}</td><td>${esc(l.unit)}</td>
      <td class="num">${l.discount !== '' && l.discount != null ? fmt(l.discount) : ''}</td><td class="num">${l.bonus !== '' && l.bonus != null ? fmt(l.bonus) : ''}</td></tr>`).join('');
    const loc = o.location ? `<a href="https://maps.google.com/?q=${o.location.lat},${o.location.lng}" target="_blank" rel="noopener">Ver en mapa</a>` : 'sin ubicación';
    const body = openModal(`Pedido #${o.id}`, `
      ${justSaved ? '<div class="banner" style="background:#ecfdf5;color:#065f46;border-radius:8px;margin-bottom:.6rem">✔ Pedido guardado. Puedes exportarlo ahora o luego desde la pestaña Pedidos.</div>' : ''}
      <div><b>${esc(o.clientName)}</b> ${o.clientCode ? `<span class="muted small">(${esc(o.clientCode)})</span>` : ''}</div>
      <div class="small muted">${fmtDay(isoDay(o.date))} ${fmtTime(o.date)} · ${loc}${o.distance != null ? ` · a ${fmtDist(o.distance)} del cliente` : ''}</div>
      ${o.exportedAt ? `<div class="small muted">Exportado: ${fmtDay(isoDay(o.exportedAt))} ${fmtTime(o.exportedAt)}</div>` : ''}
      <table class="detail mt"><thead><tr><th>Cód.</th><th>Producto</th><th class="num">Cant.</th><th>UM</th><th class="num">Desc.</th><th class="num">Bonif.</th></tr></thead><tbody>${rows}</tbody></table>
      ${o.notes ? `<p class="small"><b>Obs.:</b> ${esc(o.notes)}</p>` : ''}
      <div class="row gap-s wrap mt">
        <button class="btn primary" data-a="export">⬇ Excel</button>
        <button class="btn" data-a="share">📤 Compartir</button>
        <button class="btn" data-a="edit">✏ Editar</button>
        <button class="btn" data-a="dup">⧉ Repetir</button>
        ${c ? '<button class="btn" data-a="saveList">📋 Usar como lista habitual</button>' : ''}
        <button class="btn danger" data-a="del">🗑 Eliminar</button>
      </div>`);
    body.addEventListener('click', async e => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (!a) return;
      if (a === 'export') doExport([o], 'single');
      if (a === 'share') doExport([o], 'single', true);
      if (a === 'edit' || a === 'dup') {
        if (S.draft.lines.length && !confirm('Hay un pedido en curso. ¿Reemplazarlo?')) return;
        S.draft = { ...newDraft(), clientId: o.clientId, lines: o.lines.map(l => ({ ...l })), notes: o.notes,
          editingId: a === 'edit' ? o.id : null, origDate: a === 'edit' ? o.date : null };
        saveDraft(); await computeCommitted(); closeModal(); renderLines(); renderClientCard(); showView('pedido');
      }
      if (a === 'saveList' && c) {
        if (c.products?.length && !confirm(`¿Reemplazar la lista habitual de ${c.name} (${c.products.length} productos)?`)) return;
        c.products = o.lines.map(l => ({ code: l.code, name: l.name, qty: l.qty, unit: l.unit, discount: l.discount }));
        await DB.put('clients', c); toast('Lista habitual actualizada');
      }
      if (a === 'del' && confirm(`¿Eliminar el pedido #${o.id}? Esta acción no se puede deshacer.`)) {
        await DB.del('orders', o.id); await computeCommitted(); closeModal(); renderHistory(); toast('Pedido eliminado');
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
        <div class="grow"><div class="name">${esc(c.name)}</div>
        <div class="sub">${esc([c.code, c.address].filter(Boolean).join(' · '))}</div></div>
        <div class="small muted" style="text-align:right">${hasCoords(c) ? '📍' : '<span title="Sin ubicación">❔</span>'} ${c.products?.length ? `${c.products.length} prod.` : ''}</div>
      </div>`).join('')}</div>` : '<div class="empty">No hay clientes. Crea uno con “+ Nuevo” o importa un Excel con columnas Codigo, Nombre, Direccion, Latitud, Longitud y Productos.</div>';
  }

  function openClientEditor(id, opts = {}) {
    const orig = id ? clientById(id) : null;
    const c = orig ? JSON.parse(JSON.stringify(orig)) : { code: '', name: '', address: '', phone: '', lat: null, lng: null, radius: null, products: [] };
    if (!orig && opts.useHere && S.position) { c.lat = S.position.lat; c.lng = S.position.lng; }
    c.products = c.products || [];

    const body = openModal(orig ? 'Editar cliente' : 'Nuevo cliente', `
      <label class="field">Nombre *<input id="ceName" value="${esc(c.name)}"></label>
      <div class="row gap-s">
        <label class="field grow">Código / NIT<input id="ceCode" value="${esc(c.code)}"></label>
        <label class="field grow">Teléfono<input id="cePhone" type="tel" value="${esc(c.phone)}"></label>
      </div>
      <label class="field">Dirección<input id="ceAddr" value="${esc(c.address)}"></label>
      <div class="row gap-s">
        <label class="field grow">Latitud<input id="ceLat" type="number" step="any" inputmode="decimal" value="${c.lat ?? ''}"></label>
        <label class="field grow">Longitud<input id="ceLng" type="number" step="any" inputmode="decimal" value="${c.lng ?? ''}"></label>
        <label class="field" style="width:5.5rem">Radio (m)<input id="ceRad" type="number" inputmode="numeric" placeholder="${S.settings.radius}" value="${c.radius ?? ''}"></label>
      </div>
      <div class="row gap-s wrap">
        <button class="btn small" id="ceHere">📍 Usar mi ubicación actual</button>
        <a class="btn small" id="ceMap" target="_blank" rel="noopener">🗺 Ver en mapa</a>
      </div>
      <h2 class="mt">Lista habitual de productos</h2>
      <p class="small muted" style="margin-top:0">Se carga automáticamente al iniciar un pedido para este cliente.</p>
      <input type="search" id="ceSearch" placeholder="Agregar producto…" autocomplete="off">
      <div id="ceResults" class="results"></div>
      <div id="ceList" class="mt"></div>
      <div class="row gap-s wrap mt">
        <button class="btn primary grow" id="ceSave">Guardar</button>
        ${orig ? '<button class="btn" id="ceOrder">🛒 Hacer pedido</button><button class="btn danger" id="ceDel">Eliminar</button>' : ''}
      </div>`);

    const updMap = () => {
      const lat = $('#ceLat', body).value, lng = $('#ceLng', body).value;
      const a = $('#ceMap', body);
      a.href = lat && lng ? `https://maps.google.com/?q=${lat},${lng}` : `https://maps.google.com/?q=${encodeURIComponent($('#ceAddr', body).value)}`;
    };
    const renderList = () => {
      $('#ceList', body).innerHTML = c.products.length ? c.products.map((p, i) => `
        <div class="item" style="cursor:default">
          <div class="grow"><div class="name">${esc(S.products.get(p.code)?.name || p.name || p.code)}</div><div class="sub">${esc(p.code)}</div></div>
          <input class="mini" type="number" inputmode="decimal" value="${esc(p.qty)}" data-lq="${i}" title="Cantidad sugerida">
          <select class="mini" data-lu="${i}"><option ${p.unit !== 'UN' ? 'selected' : ''}>CAR</option><option ${p.unit === 'UN' ? 'selected' : ''}>UN</option></select>
          <button class="btn small ghost danger" data-lr="${i}">✕</button>
        </div>`).join('') : '<div class="small muted">Sin productos en la lista.</div>';
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
        t.textContent = 'Obteniendo…';
        navigator.geolocation.getCurrentPosition(pos => {
          S.position = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy, at: Date.now() };
          $('#ceLat', body).value = pos.coords.latitude.toFixed(6); $('#ceLng', body).value = pos.coords.longitude.toFixed(6);
          t.textContent = `📍 Listo (±${Math.round(pos.coords.accuracy)} m)`; updMap();
        }, () => { t.textContent = '📍 Usar mi ubicación actual'; toast('No se pudo obtener la ubicación'); }, { enableHighAccuracy: true, timeout: 20000 });
      }
      if (t.id === 'ceSave') {
        const name = $('#ceName', body).value.trim();
        if (!name) { toast('El nombre es obligatorio'); return; }
        const pf = (v) => (v === '' ? null : parseFloat(v));
        Object.assign(c, {
          name, code: $('#ceCode', body).value.trim(), phone: $('#cePhone', body).value.trim(), address: $('#ceAddr', body).value.trim(),
          lat: pf($('#ceLat', body).value), lng: pf($('#ceLng', body).value), radius: pf($('#ceRad', body).value),
        });
        const newId = await DB.put('clients', c);
        S.clients = await DB.all('clients');
        closeModal(); toast('Cliente guardado');
        if (opts.selectAfter) setClient(newId, false, null);
        renderClients(); renderClientCard();
      }
      if (t.id === 'ceDel' && confirm(`¿Eliminar el cliente ${orig.name}? Sus pedidos guardados se conservan.`)) {
        await DB.del('clients', orig.id); S.clients = await DB.all('clients');
        if (S.draft.clientId === orig.id) { S.draft.clientId = null; saveDraft(); }
        closeModal(); renderClients(); renderClientCard(); toast('Cliente eliminado');
      }
      if (t.id === 'ceOrder') {
        closeModal();
        if (S.draft.lines.length && S.draft.clientId !== orig.id && !confirm('Hay un pedido en curso para otro cliente. ¿Cambiar el cliente del pedido?')) return;
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
          Object.assign(ex, Object.fromEntries(Object.entries(n).filter(([k, v]) => v !== null && v !== '' && !(Array.isArray(v) && !v.length))));
          await DB.put('clients', ex); updated++;
        } else { await DB.put('clients', n); added++; }
      }
      S.clients = await DB.all('clients');
      renderClients(); renderClientCard();
      toast(`Clientes importados: ${added} nuevos, ${updated} actualizados`);
      if (S.position) autoDetectClient(false);
    } catch (e) { alert(e.message); }
  }

  /* ======================= Inventario ======================= */
  async function importInventoryFile(file, fileName) {
    fileName = fileName || file.name || '';
    try {
      toast('Leyendo inventario…', 10000);
      const r = await Excel.parseInventory(file, fileName);
      const date = isoDay(r.date);
      if (S.inventory && date < S.inventory.date &&
        !confirm(`Este archivo es del ${fmtDay(date)}, más antiguo que el cargado (${fmtDay(S.inventory.date)}). ¿Reemplazar de todas formas?`)) return;
      await DB.replaceAll('products', r.products);
      S.inventory = { date, fileName, importedAt: new Date().toISOString(), count: r.products.length, sheet: r.sheet, refCount: r.refCount };
      await DB.setMeta('inventory', S.inventory);
      S.products = new Map(r.products.map(p => [p.code, p]));
      await computeCommitted();
      renderHeader(); renderInventory(); renderLines(); renderProdResults();
      toast(`✔ Inventario del ${fmtDay(date)} cargado: ${r.products.length} productos`, 4000);
      return true;
    } catch (e) {
      console.error(e); $('#toast').classList.add('hidden');
      throw e;
    }
  }

  function renderInventory() {
    const inv = S.inventory;
    $('#invSummary').innerHTML = inv
      ? `<b>Inventario del ${fmtDay(inv.date)}</b><br>${fmt(inv.count)} productos · ${fmt(inv.refCount || 0)} referencias habituales ⭐<br>
         <span class="small">Archivo: ${esc(inv.fileName)} (hoja “${esc(inv.sheet)}”) · cargado ${fmtDay(isoDay(inv.importedAt))} ${fmtTime(inv.importedAt)}</span>`
      : 'Aún no se ha cargado ningún inventario.';
    const q = norm($('#invSearch').value).trim();
    const f = $('#invFilter').value;
    let list = q ? searchProducts(q, 200) : [...S.products.values()].sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
    if (f === 'ref') list = list.filter(p => p.ref);
    if (f === 'stock') list = list.filter(p => available(p.code) > 0);
    const total = list.length;
    $('#invList').innerHTML = list.slice(0, 150).map(p => `
      <div class="item" style="cursor:default">
        <div class="grow"><div class="name">${esc(p.name)}</div>
        <div class="sub">${esc(p.code)} · ${esc(p.group)}${p.ref ? ' · ⭐' : ''} · Stock ${fmt(p.stock)} · Tráns. ${fmt(p.transito)} · Pend. ${fmt(p.pendiente)}${S.committed.get(p.code) ? ` · Mis pedidos ${fmt(S.committed.get(p.code))}` : ''}</div></div>
        ${stockBadge(p.code)}
      </div>`).join('') + (total > 150 ? `<div class="empty">Mostrando 150 de ${total}. Usa la búsqueda.</div>` : '');
  }

  /* ======================= Ajustes / respaldo ======================= */
  async function renderSettings() {
    $('#setRadius').value = S.settings.radius;
    $('#setDeduct').checked = !!S.settings.deduct;
    const orders = await DB.all('orders');
    $('#stats').innerHTML = `Productos: ${S.products.size}<br>Clientes: ${S.clients.length} (${S.clients.filter(hasCoords).length} con ubicación)<br>Pedidos guardados: ${orders.length}`;
  }
  async function saveSettings() {
    S.settings.radius = Number($('#setRadius').value) || 150;
    S.settings.deduct = $('#setDeduct').checked;
    await DB.setMeta('settings', S.settings);
    toast('Ajustes guardados');
  }
  async function backup() {
    const data = {
      app: 'pedidos-colombina', version: 1, exportedAt: new Date().toISOString(),
      products: await DB.all('products'), clients: await DB.all('clients'), orders: await DB.all('orders'), meta: await DB.all('meta'),
    };
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    await shareBlob(blob, `respaldo_pedidos_${isoDay(new Date())}.json`, 'Respaldo pedidos');
    await DB.setMeta('lastBackup', data.exportedAt);
  }
  async function restore(file) {
    try {
      const data = JSON.parse(await file.text());
      if (data.app !== 'pedidos-colombina') throw new Error('El archivo no es una copia de esta aplicación.');
      if (!confirm(`Se reemplazarán TODOS los datos actuales por la copia del ${fmtDay(isoDay(data.exportedAt))} (${data.orders.length} pedidos, ${data.clients.length} clientes). ¿Continuar?`)) return;
      await DB.replaceAll('products', data.products); await DB.replaceAll('clients', data.clients);
      await DB.replaceAll('orders', data.orders); await DB.replaceAll('meta', data.meta);
      await loadAll(); renderAll(); toast('Copia restaurada');
    } catch (e) { alert('No se pudo restaurar: ' + e.message); }
  }

  /* ======================= Archivos compartidos (Android "Compartir") ======================= */
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
      catch (e) {
        if (confirm(`"${name}" no parece un inventario (${e.message}).\n¿Importarlo como lista de clientes?`)) { await importClientsFile(blob); showView('clientes'); }
      }
    } catch (e) { console.error(e); }
  }

  /* ======================= Eventos ======================= */
  function bindEvents() {
    $$('.tabbar button').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));
    document.addEventListener('click', e => { const g = e.target.closest('[data-go]'); if (g) showView(g.dataset.go); });
    $('#modalClose').addEventListener('click', closeModal);
    $('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });

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
        toast('Ubicación guardada. La próxima visita se detectará automáticamente.'); renderClientCard();
      }
      if (a === 'newClientHere') openClientEditor(null, { useHere: true, selectAfter: true });
      if (a === 'cancelEdit' && confirm('¿Descartar los cambios de la edición?')) {
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
      if (S.draft.lines.length && confirm('¿Quitar todos los productos del pedido?')) { S.draft.lines = []; saveDraft(); renderLines(); }
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
      if (!S.selectedOrders.size && chosen.length && !confirm(`No seleccionaste pedidos. ¿Exportar los ${chosen.length} pedidos del filtro actual?`)) return;
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
      if (f) try { await importInventoryFile(f); } catch (err) { alert('No se pudo leer el inventario: ' + err.message); }
    });
    $('#invSearch').addEventListener('input', debounce(renderInventory, 150));
    $('#invFilter').addEventListener('change', renderInventory);

    // Más
    $('#setRadius').addEventListener('change', saveSettings);
    $('#setDeduct').addEventListener('change', async () => { await saveSettings(); renderLines(); });
    $('#btnBackup').addEventListener('click', backup);
    $('#restoreFile').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) restore(f); });
    window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); S.installEvt = e; $('#btnInstall').hidden = false; });
    $('#btnInstall').addEventListener('click', async () => { if (S.installEvt) { S.installEvt.prompt(); S.installEvt = null; $('#btnInstall').hidden = true; } });

    // Al volver a la app, re-detectar el cliente si no hay pedido en curso
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && !S.draft.lines.length && (!S.position || Date.now() - S.position.at > 60000)) locate();
    });
  }

  function renderAll() { renderHeader(); renderClientCard(); renderLines(); renderProdResults(); }

  /* ======================= Inicio ======================= */
  async function init() {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW', err));
    if (navigator.storage?.persist) navigator.storage.persist();
    loadDraft();
    await loadAll();
    if (!S.inventory) {
      try {
        const res = await fetch('assets/inventario_inicial.xlsx');
        if (res.ok) await importInventoryFile(await res.blob(), 'Inventario 06-11-26.xlsx');
      } catch (e) { /* sin inventario inicial */ }
    }
    bindEvents();
    renderAll();
    await handleSharedFile();
    locate();
  }
  init();
})();
