/* Lectura y generación de archivos Excel (usa ExcelJS, funciona sin conexión). */
const Excel = (() => {
  const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const TEMPLATE_URL = 'assets/Plantillas.xlsx';
  const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

  const norm = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();

  /** Devuelve el valor "visible" de una celda de ExcelJS (resuelve fórmulas, texto enriquecido, etc.). */
  function cellVal(v) {
    if (v === null || v === undefined) return null;
    if (v instanceof Date) return v;
    if (typeof v === 'object') {
      if ('result' in v) return cellVal(v.result);
      if ('formula' in v || 'sharedFormula' in v) return null;
      if (v.richText) return v.richText.map(t => t.text).join('');
      if ('text' in v) return v.text;
      if ('error' in v) return null;
      return null;
    }
    return v;
  }
  const num = (v) => {
    v = cellVal(v);
    if (v === null || v === '') return null;
    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
    return isNaN(n) ? null : n;
  };
  const str = (v) => { v = cellVal(v); return v === null ? '' : String(v).trim(); };
  const codeOf = (v) => {
    v = cellVal(v);
    if (v === null || v === '') return '';
    if (typeof v === 'number') return String(Math.round(v));
    return String(v).trim().replace(/\.0+$/, '');
  };
  const round3 = (n) => Math.round((n || 0) * 1000) / 1000;

  async function loadWorkbook(fileOrBuffer) {
    const buf = fileOrBuffer instanceof ArrayBuffer ? fileOrBuffer : await fileOrBuffer.arrayBuffer();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    return wb;
  }

  /** Busca la fila de encabezados y devuelve {row, cols: {campo: índiceColumna}} según los alias dados. */
  function findHeader(ws, aliases, maxRow = 10) {
    for (let r = 1; r <= Math.min(maxRow, ws.rowCount); r++) {
      const row = ws.getRow(r);
      const map = {};
      row.eachCell((cell, c) => { const k = norm(cellVal(cell.value)); if (k) map[k] = c; });
      const cols = {};
      for (const [field, list] of Object.entries(aliases)) {
        for (const a of list) {
          const hit = a.endsWith('*')
            ? Object.keys(map).find(k => k.startsWith(a.slice(0, -1)))
            : (map[a] ? a : null);
          if (hit) { cols[field] = map[hit]; break; }
        }
      }
      if (cols.code && cols.name) return { row: r, cols };
    }
    return null;
  }

  const INV_ALIASES = {
    code: ['material', 'cod', 'codigo', 'cod material'],
    name: ['texto breve de material', 'material (referencia)', 'descripcion', 'nombre', 'producto'],
    group: ['denominacion', 'gpo.comisiones', 'grupo'],
    stock: ['stock disponible', 'inv hoy'],
    transito: ['transito', 'stock en transito'],
    pendiente: ['pendiente por facturar', 'pendiente x facturar', 'pendiente*'],
    disponible: ['disponible'],
  };

  function inventoryDateFrom(fileName, sheetNames) {
    const m = String(fileName || '').match(/(\d{1,2})[-_. ](\d{1,2})[-_. ](\d{2,4})/);
    if (m) {
      let y = parseInt(m[3], 10); if (y < 100) y += 2000;
      const d = new Date(y, parseInt(m[2], 10) - 1, parseInt(m[1], 10));
      if (!isNaN(d)) return d;
    }
    for (const n of sheetNames) {
      const mm = norm(n).match(/(\d{1,2}) (?:de )?([a-z]+)/);
      if (mm && MONTHS.includes(mm[2])) {
        const now = new Date();
        return new Date(now.getFullYear(), MONTHS.indexOf(mm[2]), parseInt(mm[1], 10));
      }
    }
    return new Date();
  }

  /** Lee el Excel de inventario diario. Detecta automáticamente la hoja y las columnas. */
  async function parseInventory(file, fileName) {
    const wb = await loadWorkbook(file);
    const sheets = [];
    wb.eachSheet(ws => {
      if (ws.state && ws.state !== 'visible' && /hiddensheet/i.test(ws.name)) return;
      const h = findHeader(ws, INV_ALIASES);
      if (h && (h.cols.disponible || h.cols.stock)) sheets.push({ ws, h });
    });
    if (!sheets.length) throw new Error('No se encontró una hoja con columnas de Material / Descripción.');

    const readSheet = ({ ws, h }) => {
      const out = [];
      for (let r = h.row + 1; r <= ws.rowCount; r++) {
        const row = ws.getRow(r);
        const g = (f) => (h.cols[f] ? row.getCell(h.cols[f]).value : null);
        const code = codeOf(g('code'));
        if (!code || !/^\w+$/.test(code)) continue;
        const stock = num(g('stock')) ?? 0;
        const transito = num(g('transito')) ?? 0;
        const pendiente = num(g('pendiente')) ?? 0;
        let disponible = num(g('disponible'));
        if (disponible === null) disponible = h.cols.stock ? stock + transito - pendiente : 0;
        out.push({
          code, name: str(g('name')), group: str(g('group')),
          stock: round3(stock), transito: round3(transito), pendiente: round3(pendiente), disponible: round3(disponible),
        });
      }
      return out;
    };

    // Hoja principal = la que tiene más productos; las demás marcan "referencias habituales".
    const parsed = sheets.map(s => ({ name: s.ws.name, rows: readSheet(s) })).sort((a, b) => b.rows.length - a.rows.length);
    const main = parsed[0];
    const refCodes = new Set();
    parsed.slice(1).forEach(p => p.rows.forEach(r => refCodes.add(r.code)));

    const byCode = new Map();
    main.rows.forEach(p => { if (!byCode.has(p.code)) byCode.set(p.code, { ...p, ref: refCodes.has(p.code) }); });
    // Productos que solo están en la hoja de referencias también se incluyen
    parsed.slice(1).forEach(p => p.rows.forEach(r => { if (!byCode.has(r.code)) byCode.set(r.code, { ...r, ref: true }); }));

    return {
      products: [...byCode.values()],
      date: inventoryDateFrom(fileName, wb.worksheets.map(w => w.name)),
      sheet: main.name,
      refCount: refCodes.size,
    };
  }

  /* ---------------- Clientes ---------------- */
  const CLI_ALIASES = {
    code: ['codigo', 'cod', 'cod cliente', 'codigo cliente', 'nit', 'id'],
    name: ['nombre', 'cliente', 'razon social', 'establecimiento'],
    address: ['direccion'],
    phone: ['telefono', 'celular'],
    lat: ['latitud', 'lat'],
    lng: ['longitud', 'lng', 'lon'],
    radius: ['radio', 'radio (m)'],
    products: ['productos', 'lista', 'lista habitual'],
  };

  /** Columna "Productos": códigos separados por coma, opcionalmente con cantidad "codigo:cant". */
  function parseProductList(s) {
    return String(s || '').split(/[,;\n]+/).map(t => t.trim()).filter(Boolean).map(t => {
      const [c, q, u] = t.split(':').map(x => x && x.trim());
      return { code: c.replace(/\.0+$/, ''), qty: q ? parseFloat(q.replace(',', '.')) || 0 : 1, unit: (u || 'CAR').toUpperCase() };
    });
  }

  async function parseClients(file) {
    const wb = await loadWorkbook(file);
    for (const ws of wb.worksheets) {
      const aliases = { ...CLI_ALIASES };
      const h = findHeader(ws, aliases);
      if (!h) continue;
      const out = [];
      for (let r = h.row + 1; r <= ws.rowCount; r++) {
        const row = ws.getRow(r);
        const g = (f) => (h.cols[f] ? row.getCell(h.cols[f]).value : null);
        const name = str(g('name'));
        if (!name) continue;
        out.push({
          code: codeOf(g('code')), name, address: str(g('address')), phone: str(g('phone')),
          lat: num(g('lat')), lng: num(g('lng')), radius: num(g('radius')),
          products: parseProductList(str(g('products'))),
        });
      }
      return out;
    }
    throw new Error('El archivo debe tener columnas "Codigo" y "Nombre" (opcional: Direccion, Telefono, Latitud, Longitud, Radio, Productos).');
  }

  async function exportClients(clients) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Clientes');
    ws.columns = [
      { header: 'Codigo', key: 'code', width: 12 }, { header: 'Nombre', key: 'name', width: 32 },
      { header: 'Direccion', key: 'address', width: 30 }, { header: 'Telefono', key: 'phone', width: 14 },
      { header: 'Latitud', key: 'lat', width: 12 }, { header: 'Longitud', key: 'lng', width: 12 },
      { header: 'Radio', key: 'radius', width: 8 }, { header: 'Productos', key: 'products', width: 60 },
    ];
    ws.getRow(1).font = { bold: true };
    clients.forEach(c => ws.addRow({
      ...c, products: (c.products || []).map(p => `${p.code}:${p.qty}${p.unit && p.unit !== 'CAR' ? ':' + p.unit : ''}`).join(', '),
    }));
    return toBlob(wb);
  }

  /* ---------------- Pedidos -> Plantilla ---------------- */
  async function loadTemplate() {
    const res = await fetch(TEMPLATE_URL);
    if (!res.ok) throw new Error('No se pudo cargar la plantilla.');
    return loadWorkbook(await res.arrayBuffer());
  }

  const asCode = (c) => (/^\d+$/.test(c) ? Number(c) : c);

  function writeLines(ws, lines) {
    const last = Math.max(ws.rowCount, 1000);
    for (let r = 2; r <= last; r++) for (let c = 1; c <= 5; c++) {
      const cell = ws.getCell(r, c);
      if (cell.value !== null) cell.value = null;
    }
    lines.forEach((l, i) => {
      const r = i + 2;
      ws.getCell(r, 1).value = asCode(l.code);
      ws.getCell(r, 2).value = Number(l.qty);
      ws.getCell(r, 3).value = l.unit || 'CAR';
      ws.getCell(r, 4).value = l.discount ? Number(l.discount) : null;
      ws.getCell(r, 5).value = l.bonus ? Number(l.bonus) : null;
    });
  }

  /** Copia la estructura de la hoja plantilla en una hoja nueva (encabezados, lista UN/CAR, validación). */
  function cloneTemplateSheet(wb, src, name) {
    const ws = wb.addWorksheet(name);
    src.columns.forEach((col, i) => {
      const dst = ws.getColumn(i + 1);
      if (col.width) dst.width = col.width;
      if (col.hidden) dst.hidden = true;
    });
    src.eachRow({ includeEmpty: false }, (row, r) => {
      row.eachCell((cell, c) => {
        if (r === 1 || c > 5) { ws.getCell(r, c).value = cell.value; ws.getCell(r, c).style = { ...cell.style }; }
      });
    });
    setUnitValidation(ws, unitValidation(src));
    return ws;
  }

  /** Lista desplegable UN/CAR de la plantilla (columna C). */
  function unitValidation(ws) {
    const m = ws.dataValidations && ws.dataValidations.model || {};
    const k = Object.keys(m).find(a => /^C\d/.test(a) && m[a] && m[a].type);
    return k ? { ...m[k] } : null;
  }
  /** ExcelJS genera rangos solapados al reescribir validaciones por celda; se deja un único rango limpio. */
  function setUnitValidation(ws, dv) {
    if (dv) ws.dataValidations.model = { 'C2:C1000': dv };
  }

  const safeSheetName = (s, used) => {
    let base = String(s).replace(/[\[\]:*?\/\\]/g, ' ').trim().slice(0, 28) || 'Pedido';
    let n = base, i = 2;
    while (used.has(n.toLowerCase())) n = `${base.slice(0, 26)} ${i++}`;
    used.add(n.toLowerCase());
    return n;
  };

  /** Une líneas con el mismo código/unidad/descuento sumando cantidades. */
  function consolidate(orders) {
    const map = new Map();
    orders.forEach(o => o.lines.forEach(l => {
      const k = [l.code, l.unit, l.discount || 0].join('|');
      const cur = map.get(k);
      if (cur) { cur.qty += Number(l.qty) || 0; cur.bonus = (Number(cur.bonus) || 0) + (Number(l.bonus) || 0); }
      else map.set(k, { ...l, qty: Number(l.qty) || 0 });
    }));
    return [...map.values()];
  }

  /**
   * mode: 'single'  -> un pedido en la hoja de la plantilla
   *       'merge'   -> todos los pedidos consolidados en la hoja de la plantilla
   *       'sheets'  -> una hoja (con formato de plantilla) por cada pedido
   */
  async function exportOrders(orders, mode = 'single') {
    const wb = await loadTemplate();
    const tpl = wb.worksheets[0];
    const dv = unitValidation(tpl);
    setUnitValidation(tpl, dv);
    if (mode === 'sheets' && orders.length > 1) {
      const used = new Set();
      orders.forEach((o, i) => {
        const name = safeSheetName(`${o.clientName || 'Pedido'} #${o.id}`, used);
        const ws = i === 0 ? tpl : cloneTemplateSheet(wb, tpl, name);
        if (i === 0) tpl.name = name;
        writeLines(ws, o.lines);
      });
    } else {
      writeLines(tpl, mode === 'merge' ? consolidate(orders) : orders[0].lines);
    }
    return toBlob(wb);
  }

  async function toBlob(wb) {
    const buf = await wb.xlsx.writeBuffer();
    return new Blob([buf], { type: XLSX_MIME });
  }

  return { parseInventory, parseClients, exportClients, exportOrders, XLSX_MIME };
})();
