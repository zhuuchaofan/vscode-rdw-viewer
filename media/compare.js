/* RDW Viewer 比较视图：A / B 两个表格左右并排，上下、左右滚动同步（虚拟滚动）。
 *
 * 消息协议（host ⇄ webview）见 src/extension.ts 的 openCompare / src/compare.ts。
 *  host → web : cinit / rows / cell / dump / found
 *  web  → host: ready / getRows / cellInfo / dump / findDiff / chooseKey / setIndex / swap / chooseIgnore / exportDiff
 */
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const C = window.RdwCommon;
  const S = C.S;
  const esc = C.esc;

  const ROW_H = 20;
  const BLOCK = 64;
  const LEFT_W = 11; // ch：序号 8 + 状态 3
  const SIDES = ['a', 'b'];

  const saved = vscode.getState() || {};
  const state = {
    init: null,
    gen: 0,
    diffOnly: false,
    hideFiller: true,
    cache: new Map(), // 'all' | 'diff' -> Map(blockIndex -> rows[] | 'pending')
    /** 选中：显示行 i、配对 p、点击的一侧和列，以及另一侧的对应列 */
    selected: null, // {i, p, side, col, ca, cb}
    pendingSel: null, // {i}：等待该行数据到达后选中
    dump: null, // {p, a, b}
    showDump: saved.showDump !== false,
    dumpH: saved.dumpH || 200,
  };
  const saveState = () => vscode.setState({ showDump: state.showDump, dumpH: state.dumpH });
  let hideRegex = null;

  /* ---------- DOM ---------- */
  const app = document.getElementById('app');
  const pane = (s) =>
    `<div class="pane" id="p${s}"><div class="ptitle" id="t${s}"></div>` +
    `<div class="scroller" id="s${s}"><div class="inner"><div class="hdr"></div><div class="rows"></div></div></div></div>`;
  app.innerHTML = [
    '<div id="toolbar"></div>',
    '<div id="banner"></div>',
    `<div id="panes">${pane('a')}${pane('b')}</div>`,
    '<div id="cellbar"></div>',
    '<div id="split" class="split"></div>',
    '<div id="dump" class="dump cmpdump"><div class="dcol" id="da"></div><div class="dcol" id="db"></div></div>',
  ].join('');
  const $toolbar = document.getElementById('toolbar');
  const $banner = document.getElementById('banner');
  const $cellbar = document.getElementById('cellbar');
  const $split = document.getElementById('split');
  const $dump = document.getElementById('dump');
  const side = {};
  for (const s of SIDES) {
    const sc = document.getElementById('s' + s);
    side[s] = {
      key: s,
      $title: document.getElementById('t' + s),
      $scroller: sc,
      $inner: sc.querySelector('.inner'),
      $hdr: sc.querySelector('.hdr'),
      $rows: sc.querySelector('.rows'),
      $dump: document.getElementById('d' + s),
    };
  }

  /* ---------- 列 ---------- */
  const colCache = new Map();
  function groupOf(s, key) {
    return key === null ? null : state.init[s].groups.find((g) => g.key === key) || null;
  }
  function visibleCols(s, key) {
    const ck = s + '|' + key + '|' + state.hideFiller;
    const hit = colCache.get(ck);
    if (hit) return hit;
    const g = groupOf(s, key);
    const vis = [];
    let total = 0;
    (g ? g.columns : []).forEach((col, i) => {
      if (state.hideFiller && hideRegex && hideRegex.test(col.name)) return;
      const px = C.colPx(col);
      vis.push({ i, col, px });
      total += px;
    });
    const res = { vis, total };
    colCache.set(ck, res);
    return res;
  }
  function sideWidth(s) {
    let w = 0;
    for (const c of state.init.combos) w = Math.max(w, visibleCols(s, s === 'a' ? c.ga : c.gb).total);
    return `calc(${LEFT_W}ch + ${w}px)`;
  }
  const hdrRows = () => (state.init.inline ? 0 : 3);
  const listKey = () => (state.diffOnly ? 'diff' : 'all');
  const rowCount = () => (state.diffOnly ? state.init.diffCount : state.init.count);

  /* ---------- 工具栏 / 提示条 ---------- */
  function renderToolbar() {
    const d = state.init;
    const st = d.stats;
    $toolbar.innerHTML =
      `<span class="file">A: ${esc(d.fileA)}</span><button id="swap" title="${esc(S('cmpSwapTitle'))}">⇄</button>` +
      `<span class="file">B: ${esc(d.fileB)}</span>` +
      `<span class="meta">${esc(S('cmpStats', st))}</span>` +
      `<span class="spacer"></span>` +
      `<label title="${esc(S('cmpModeTitle'))}">${esc(S('cmpMode'))} <select id="mode">` +
      `<option value="index" ${d.mode === 'index' ? 'selected' : ''}>${esc(S('cmpModeIndex'))}</option>` +
      `<option value="key" ${d.mode === 'key' ? 'selected' : ''}>${esc(S('cmpModeKey'))}</option></select></label>` +
      (d.mode === 'key' ? `<button id="key" title="${esc(S('cmpKeyTitle'))}">${esc(S('cmpKey', { label: d.keyLabel }))}</button>` : '') +
      `<button id="ignore" title="${esc(S('cmpIgnoreTitle'))}">${esc(S('cmpIgnore', { n: d.ignore.length }))}</button>` +
      `<label><input type="checkbox" id="diffOnly" ${state.diffOnly ? 'checked' : ''}>${esc(S('cmpDiffOnly'))}</label>` +
      `<button id="prev" title="${esc(S('cmpPrevTitle'))}">↑ ${esc(S('cmpPrev'))}</button>` +
      `<button id="next" title="${esc(S('cmpNextTitle'))}">↓ ${esc(S('cmpNext'))}</button>` +
      `<label title="${esc(S('hideFillerTitle'))}"><input type="checkbox" id="hideFiller" ${state.hideFiller ? 'checked' : ''}>${esc(S('hideFiller'))}</label>` +
      `<label title="${esc(S('dumpToggleTitle'))}"><input type="checkbox" id="showDump" ${state.showDump ? 'checked' : ''}>${esc(S('dumpToggle'))}</label>` +
      `<button id="exportDiff" title="${esc(S('cmpExportTitle'))}">${esc(S('cmpExport'))}</button>`;
    document.getElementById('swap').onclick = () => vscode.postMessage({ type: 'swap' });
    document.getElementById('mode').onchange = (ev) =>
      vscode.postMessage({ type: ev.target.value === 'key' ? 'chooseKey' : 'setIndex' });
    const key = document.getElementById('key');
    if (key) key.onclick = () => vscode.postMessage({ type: 'chooseKey' });
    document.getElementById('ignore').onclick = () => vscode.postMessage({ type: 'chooseIgnore' });
    document.getElementById('exportDiff').onclick = () => vscode.postMessage({ type: 'exportDiff' });
    document.getElementById('diffOnly').onchange = (ev) => {
      state.diffOnly = ev.target.checked;
      state.selected = null;
      state.dump = null;
      resetView(false);
    };
    document.getElementById('prev').onclick = () => findDiff(-1);
    document.getElementById('next').onclick = () => findDiff(1);
    document.getElementById('hideFiller').onchange = (ev) => {
      state.hideFiller = ev.target.checked;
      resetView(true);
    };
    document.getElementById('showDump').onchange = (ev) => {
      state.showDump = ev.target.checked;
      saveState();
      renderDump();
      if (state.showDump && state.selected) requestDump(state.selected.p);
    };
  }

  function renderBanner() {
    const d = state.init;
    const st = d.stats;
    const parts = [
      d.mode === 'key' ? S('cmpByKey', { label: d.keyLabel }) : S('cmpByIndex'),
      S('cmpSummary', st),
    ];
    if (st.noKeyA || st.noKeyB) parts.push(S('cmpNoKey', { a: st.noKeyA, b: st.noKeyB }));
    if (d.ignore.length) parts.push(S('cmpIgnored', { list: d.ignore.join(', ') }));
    if (d.a.errorCount || d.b.errorCount) parts.push(S('cmpErrors', { a: d.a.errorCount, b: d.b.errorCount }));
    parts.push(S('cmpCopybookNote'));
    $banner.className = st.chg || st.a || st.b ? 'warn' : 'info';
    const icon = st.chg || st.a || st.b ? '⚠' : 'ℹ';
    $banner.innerHTML = `<span class="ico">${icon}</span><span class="text" title="${esc(parts.join('\n'))}">${esc(parts.join(' '))}</span>`;
  }

  function renderTitles() {
    const d = state.init;
    for (const s of SIDES) {
      const info = d[s];
      side[s].$title.innerHTML =
        `<b>${s.toUpperCase()}</b> ${esc(s === 'a' ? d.fileA : d.fileB)} ` +
        `<span class="meta">${esc(S('records', { n: info.total - info.errorCount }))}</span>` +
        info.groups
          .map((g) => `<span class="cbn">${esc(S('bytes', { n: g.length }))}${g.value !== null ? '=' + esc(g.value) : ''}: ${esc(g.copybookName || S('noCopybook'))}</span>`)
          .join('');
    }
  }

  function clearCellbar() {
    $cellbar.innerHTML = `<span class="hint">${esc(S('cmpCellHint'))}</span>`;
  }

  /* ---------- 行 ---------- */
  function headerHtml(s, gkey, k, top) {
    const label = gkey === null ? '' : [S('hdrName'), S('hdrPic'), S('hdrPos')][k].replace(/ /g, '');
    const topAttr = top === undefined ? '' : ` data-top="${top}"`;
    return (
      `<div class="row hdrrow k${k}"${topAttr}><div class="c l lch hd">${label}</div>` +
      (gkey === null ? '' : C.headerCells(visibleCols(s, gkey).vis, k)) +
      '</div>'
    );
  }

  const MARK = { same: '', chg: '≠', a: '−', b: '+' };

  function rowHtml(s, row, i) {
    const top = i * ROW_H;
    if (row.t === 'hdr') return headerHtml(s, s === 'a' ? row.ga : row.gb, row.k, top);
    const rec = row[s];
    const sel = state.selected && state.selected.i === i ? state.selected : null;
    const cls = `row st-${row.st}${i % 2 ? ' odd' : ''}${sel ? ' selrow' : ''}`;
    if (!rec) {
      return `<div class="${cls} ph" data-top="${top}" data-r="${i}"><div class="c l lc0"></div><div class="c l lc1"></div></div>`;
    }
    const diffs = new Set(s === 'a' ? row.da : row.db);
    const warns = new Set(rec.w);
    const selCol = sel ? (s === 'a' ? sel.ca : sel.cb) : -1;
    let html = `<div class="${cls}" data-top="${top}">`;
    html += `<div class="c l lc0" title="${esc(S('offset'))} 0x${rec.o.toString(16).toUpperCase()}">${rec.e + 1}</div>`;
    html += `<div class="c l lc1">${MARK[row.st]}</div>`;
    for (const { i: ci, col, px } of visibleCols(s, rec.g).vis) {
      const text = rec.c[ci];
      const c =
        (C.isNumeric(col) && col.kind !== 'missing' ? ' num' : '') +
        (diffs.has(ci) ? ' dd' : '') +
        (warns.has(ci) ? ' w' : '') +
        (ci === selCol ? ' sel' : '') +
        (C.FILLER_RE.test(col.name) || col.kind === 'extra' ? ' dim' : '') +
        (text.trim() === '' ? ' blank' : '');
      html += `<div class="c f${c}" data-w="${px}" data-r="${i}" data-c="${ci}" title="${esc(C.plainSeg(text))}">${C.cellHtml(text, col)}</div>`;
    }
    return html + '</div>';
  }

  function cacheFor(k) {
    let m = state.cache.get(k);
    if (!m) {
      m = new Map();
      state.cache.set(k, m);
    }
    return m;
  }
  function rowAt(i) {
    const b = Math.floor(i / BLOCK);
    const block = cacheFor(listKey()).get(b);
    return block && block !== 'pending' ? block[i - b * BLOCK] : undefined;
  }
  function requestBlock(b) {
    const m = cacheFor(listKey());
    if (m.has(b)) return;
    m.set(b, 'pending');
    vscode.postMessage({ type: 'getRows', gen: state.gen, d: state.diffOnly, start: b * BLOCK, count: BLOCK });
  }

  let drawQueued = false;
  function scheduleDraw() {
    if (!drawQueued) {
      drawQueued = true;
      requestAnimationFrame(() => {
        drawQueued = false;
        draw();
      });
    }
  }

  function draw() {
    if (!state.init) return;
    const n = rowCount();
    const hdrH = hdrRows() * ROW_H;
    const sc = side.a.$scroller;
    const top = sc.scrollTop;
    const first = Math.max(0, Math.floor((top - hdrH) / ROW_H) - 3);
    const last = Math.min(n - 1, Math.ceil((top + sc.clientHeight - hdrH) / ROW_H) + 3);
    const html = { a: '', b: '' };
    for (let i = first; i <= last; i++) {
      const row = rowAt(i);
      if (!row) {
        requestBlock(Math.floor(i / BLOCK));
        continue;
      }
      for (const s of SIDES) html[s] += rowHtml(s, row, i);
    }
    for (const s of SIDES) {
      side[s].$rows.innerHTML = html[s];
      C.applyLayout(side[s].$rows, sideWidth(s));
    }
  }

  function renderStaticHeader() {
    for (const s of SIDES) {
      const $h = side[s].$hdr;
      if (state.init.inline) {
        $h.style.display = 'none';
        $h.innerHTML = '';
        continue;
      }
      const c = state.init.combos[0];
      const gkey = c ? (s === 'a' ? c.ga : c.gb) : null;
      $h.style.display = '';
      $h.style.width = sideWidth(s);
      $h.innerHTML = [0, 1, 2].map((k) => headerHtml(s, gkey, k)).join('');
      C.applyLayout($h, sideWidth(s));
    }
  }

  function resetView(keepScroll) {
    colCache.clear();
    const n = rowCount();
    for (const s of SIDES) {
      const x = side[s];
      if (!keepScroll) {
        x.$scroller.scrollTop = 0;
        x.$scroller.scrollLeft = 0;
      }
      x.$inner.style.width = sideWidth(s);
      x.$rows.style.height = n * ROW_H + 'px';
    }
    renderStaticHeader();
    renderDump();
    if (n === 0) {
      for (const s of SIDES) side[s].$rows.innerHTML = `<div id="empty">${esc(S(state.diffOnly ? 'cmpNoDiff' : 'empty'))}</div>`;
    } else {
      draw();
    }
  }

  /* ---------- 选择 / 差异导航 ---------- */
  function select(i, s, col) {
    const row = rowAt(i);
    if (!row || row.t !== 'pair') {
      state.pendingSel = { i, s, col };
      return;
    }
    state.pendingSel = null;
    const rec = row[s] || row[s === 'a' ? 'b' : 'a'];
    if (!row[s]) s = s === 'a' ? 'b' : 'a';
    if (col === undefined || col < 0) {
      const diffs = s === 'a' ? row.da : row.db;
      col = diffs.length ? diffs[0] : -1;
    }
    state.selected = { i, p: row.p, side: s, col, ca: s === 'a' ? col : -1, cb: s === 'b' ? col : -1 };
    if (col >= 0 && rec) vscode.postMessage({ type: 'cellInfo', p: row.p, side: s, col });
    else clearCellbar();
    requestDump(row.p);
    draw();
    renderDump();
    requestAnimationFrame(() => {
      const el = side[s].$rows.querySelector('.c.f.sel');
      if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }

  function findDiff(dir) {
    let from = state.selected ? state.selected.i : -1;
    if (!state.selected && dir < 0) from = rowCount();
    if (!state.selected && dir > 0) {
      // 从当前可见的第一行开始
      const top = side.a.$scroller.scrollTop - hdrRows() * ROW_H;
      from = Math.max(-1, Math.floor(top / ROW_H) - 1);
    }
    vscode.postMessage({ type: 'findDiff', d: state.diffOnly, from, dir });
  }

  function scrollToRow(i) {
    const sc = side.a.$scroller;
    const y = hdrRows() * ROW_H + i * ROW_H;
    if (y < sc.scrollTop + hdrRows() * ROW_H || y + ROW_H > sc.scrollTop + sc.clientHeight) {
      sc.scrollTop = Math.max(0, y - sc.clientHeight / 3);
    }
  }

  /* ---------- 十六进制 dump ---------- */
  function requestDump(p) {
    if (state.showDump) vscode.postMessage({ type: 'dump', p });
  }
  function renderDump() {
    $split.style.display = state.showDump ? '' : 'none';
    $dump.style.display = state.showDump ? '' : 'none';
    if (!state.showDump) return;
    const d = state.dump && state.selected && state.dump.p === state.selected.p ? state.dump : null;
    for (const s of SIDES) {
      const o = s === 'a' ? 'b' : 'a';
      const info = d ? d[s] : null;
      const sel = state.selected;
      const title = `<div class="dtitle"><b>${s.toUpperCase()}</b> ${esc(s === 'a' ? state.init.fileA : state.init.fileB)}</div>`;
      side[s].$dump.innerHTML =
        title +
        C.dumpHtml(info, {
          selCol: sel ? (s === 'a' ? sel.ca : sel.cb) : undefined,
          other: d && d[o] ? d[o].bytes : null,
          empty: d ? S('cmpDumpMissing') : S('dumpEmptyHint'),
        });
    }
  }
  C.splitter($split, $dump, state.dumpH, (h) => {
    state.dumpH = h;
    saveState();
  });
  for (const s of SIDES) {
    C.bindDump(
      side[s].$dump,
      () => (state.dump ? state.dump[s] : null),
      (col) => state.selected && select(state.selected.i, s, col)
    );
  }

  /* ---------- 事件 ---------- */
  C.refreshMetrics(side.a.$scroller);
  let lock = null;
  for (const s of SIDES) {
    const me = side[s].$scroller;
    const other = side[s === 'a' ? 'b' : 'a'].$scroller;
    me.addEventListener(
      'scroll',
      () => {
        if (lock && lock !== me) return;
        lock = me;
        if (other.scrollTop !== me.scrollTop) other.scrollTop = me.scrollTop;
        if (other.scrollLeft !== me.scrollLeft) other.scrollLeft = me.scrollLeft;
        requestAnimationFrame(() => (lock = null));
        scheduleDraw();
      },
      { passive: true }
    );
    side[s].$rows.addEventListener('click', (ev) => {
      const el = ev.target.closest('.c.f, .row.ph');
      if (!el) return;
      const i = Number(el.dataset.r);
      const col = el.dataset.c === undefined ? -1 : Number(el.dataset.c);
      select(i, s, col);
    });
  }
  window.addEventListener('resize', scheduleDraw);
  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'F7') {
      ev.preventDefault();
      findDiff(ev.shiftKey ? -1 : 1);
    }
  });

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    switch (msg.type) {
      case 'cinit': {
        C.setStrings(msg.strings);
        C.refreshMetrics(side.a.$scroller);
        hideRegex = C.compileHide(msg.hiddenPattern);
        state.init = msg;
        state.gen = msg.gen;
        state.cache.clear();
        state.selected = null;
        state.pendingSel = null;
        state.dump = null;
        clearCellbar();
        renderToolbar();
        renderBanner();
        renderTitles();
        resetView(false);
        break;
      }
      case 'rows': {
        if (msg.gen !== state.gen || msg.d !== state.diffOnly) return;
        cacheFor(listKey()).set(msg.start / BLOCK, msg.rows);
        if (state.pendingSel) {
          const ps = state.pendingSel;
          if (ps.i >= msg.start && ps.i < msg.start + BLOCK) select(ps.i, ps.s, ps.col);
        }
        scheduleDraw();
        break;
      }
      case 'found': {
        if (msg.i < 0) {
          $cellbar.innerHTML = `<span class="hint">${esc(S(msg.dir < 0 ? 'cmpNoPrev' : 'cmpNoNext'))}</span>`;
          return;
        }
        scrollToRow(msg.i);
        select(msg.i, 'a');
        scheduleDraw();
        break;
      }
      case 'cell': {
        const sel = state.selected;
        if (!sel || sel.p !== msg.p) return;
        const { a, b, ca, cb } = msg.info;
        sel.ca = ca;
        sel.cb = cb;
        const any = a || b;
        const differ = a && b ? a.hex !== b.hex : true;
        const val = (x) => (x ? `<span class="value ${x.warn ? 'warn' : ''}${differ ? ' dd' : ''}">${esc(x.text)}</span>` : `<span class="value none">—</span>`);
        $cellbar.innerHTML =
          `<span class="name" title="${esc(any.name)}">${esc(any.name)}</span>` +
          `<span class="tag">A</span>${val(a)}<span class="tag">B</span>${val(b)}` +
          `<span class="hint">${esc(S('cellMeta', { pic: any.pic, pos: any.start, len: any.len }))}</span>` +
          `<span class="hex" title="A: ${esc(a ? a.hex : '—')}\nB: ${esc(b ? b.hex : '—')}">A: ${esc(a ? a.hex : '—')} / B: ${esc(b ? b.hex : '—')}</span>`;
        draw();
        renderDump();
        break;
      }
      case 'dump': {
        if (!state.selected || msg.p !== state.selected.p) return;
        state.dump = { p: msg.p, a: msg.info.a, b: msg.info.b };
        renderDump();
        break;
      }
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
