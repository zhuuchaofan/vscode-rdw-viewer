/* RDW Viewer webview：按 copybook 字段横向展开的记录表格（虚拟滚动）。
 *
 * 消息协议（host ⇄ webview）见 src/extension.ts / src/session.ts。
 *  host → web : init / rows / cell
 *  web  → host: ready / getRows / cellInfo / chooseCopybook / clearCopybook / setEncoding
 */
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();

  const ROW_H = 20;
  const BLOCK = 64;
  /** 左侧固定列的宽度（ch）：序号 8 + 偏移 14（可隐藏）+ 状态 3 */
  const leftW = () => (state.showOffset ? 25 : 11);
  const ERR_VIEW = 'ERR';
  const ORDER_VIEW = 'ORDER';
  const C = window.RdwCommon;
  /** 界面文字（随 init 消息由扩展端按 VS Code 的显示语言发来） */
  const S = C.S;
  const esc = C.esc;
  const ERR_COLUMNS = [
    { name: 'offset', pic: '', start: 0, width: 12, kind: 'field', type: 'alnum' },
    { name: 'skipped', pic: '', start: 0, width: 10, kind: 'field', type: 'alnum' },
    { name: 'reason', pic: '', start: 0, width: 110, kind: 'field', type: 'alnum' },
  ];
  function localizeErrColumns() {
    ERR_COLUMNS[0].name = S('offset');
    ERR_COLUMNS[1].name = S('skipped');
    ERR_COLUMNS[2].name = S('reason');
  }

  const state = {
    init: null,
    gen: 0,
    view: null,
    hideFiller: true,
    cache: new Map(), // view -> Map(blockIndex -> rows[] | 'pending')
    selected: null, // {view,row,col}
    pending: new Set(),
    /** 十六进制 dump 面板 */
    dump: null, // 当前显示的 DumpInfo
  };
  const saved = vscode.getState() || {};
  state.showDump = saved.showDump !== false;
  state.dumpH = saved.dumpH || 180;
  state.showOffset = saved.showOffset === true;
  const saveState = () => vscode.setState({ showDump: state.showDump, dumpH: state.dumpH, showOffset: state.showOffset });

  /* ---------- DOM ---------- */
  const app = document.getElementById('app');
  app.innerHTML = [
    '<div id="toolbar"></div>',
    '<div id="tabs"></div>',
    '<div id="banner"></div>',
    '<div id="layouts"></div>',
    '<div id="scroller"><div id="inner"><div id="hdr"></div><div id="rows"></div></div></div>',
    '<div id="cellbar"></div>',
    '<div id="split" class="split"></div>',
    '<div id="dump" class="dump"></div>',
  ].join('');
  const $toolbar = document.getElementById('toolbar');
  const $tabs = document.getElementById('tabs');
  const $banner = document.getElementById('banner');
  const $layouts = document.getElementById('layouts');
  const $cellbar = document.getElementById('cellbar');
  const $scroller = document.getElementById('scroller');
  const $inner = document.getElementById('inner');
  const $hdr = document.getElementById('hdr');
  const $rows = document.getElementById('rows');
  const $split = document.getElementById('split');
  const $dump = document.getElementById('dump');
  /** 提示条「⋯」按钮的下拉菜单 */
  const $menu = document.createElement('div');
  $menu.id = 'menu';
  document.body.appendChild($menu);

  /* ---------- 列定义 ---------- */
  let hideRegex = null;

  function groupOf(key) {
    return state.init.groups.find((g) => g.key === key);
  }

  const colPx = C.colPx;
  const isNumeric = C.isNumeric;


  /** 返回某个分组/错误视图的可见列信息：[{i, col, px}]、总宽度(px) */
  const colCache = new Map();
  function visibleCols(key) {
    const hit = colCache.get(key + '|' + state.hideFiller);
    if (hit) {
      return hit;
    }
    let cols;
    if (key === ERR_VIEW) {
      cols = ERR_COLUMNS;
    } else {
      cols = groupOf(key).columns;
    }
    const vis = [];
    let total = 0;
    cols.forEach((col, i) => {
      if (state.hideFiller && hideRegex && key !== ERR_VIEW && hideRegex.test(col.name)) {
        return;
      }
      const px = colPx(col);
      vis.push({ i, col, px });
      total += px;
    });
    const res = { vis, total };
    colCache.set(key + '|' + state.hideFiller, res);
    return res;
  }

  /** 固定表头的行数：文件顺序视图没有（表头随记录插入），错误视图 1 行，其余 3 行 */
  function hdrRowsOf(view) {
    return view === ORDER_VIEW ? 0 : view === ERR_VIEW ? 1 : 3;
  }

  /* ---------- 视图尺寸 ---------- */
  function viewCount(view) {
    const d = state.init;
    if (view === ORDER_VIEW) return d.orderCount;
    if (view === ERR_VIEW) return d.errorCount;
    const g = groupOf(view);
    return g ? g.count : 0;
  }

  function viewWidth() {
    const d = state.init;
    if (state.view === ORDER_VIEW) {
      // 只有存在错误行时，才需要容纳错误行的宽度
      let w = d.errorCount ? visibleCols(ERR_VIEW).total : 0;
      d.groups.forEach((g) => (w = Math.max(w, visibleCols(g.key).total)));
      return `calc(${leftW()}ch + ${w}px)`;
    }
    return `calc(${leftW()}ch + ${visibleCols(state.view).total}px)`;
  }

  /* ---------- 渲染：工具栏 / 标签页 / 提示条 ---------- */
  function renderToolbar() {
    const d = state.init;
    const sizeKB = d.size >= 1048576 ? (d.size / 1048576).toFixed(1) + ' MB' : (d.size / 1024).toFixed(1) + ' KB';
    $toolbar.innerHTML =
      `<span class="file">${esc(d.fileName)}</span>` +
      (d.version ? `<span class="meta">v${esc(d.version)}</span>` : '') +
      `<span class="meta">${sizeKB} · ${esc(S('records', { n: d.total - d.errorCount }))}` +
      (d.errorCount ? ` · <span class="st-err">${esc(S('errors', { n: d.errorCount }))}</span>` : '') +
      `</span><span class="spacer"></span>` +
      `<label title="${esc(S('autoPackedTitle'))}"><input type="checkbox" id="autoPacked" ${d.autoPacked ? 'checked' : ''}>${esc(S('autoPacked'))}</label>` +
      `<label title="${esc(S('hideFillerTitle'))}"><input type="checkbox" id="hideFiller" ${state.hideFiller ? 'checked' : ''}>${esc(S('hideFiller'))}</label>` +
      `<label title="${esc(S('offsetToggleTitle'))}"><input type="checkbox" id="showOffset" ${state.showOffset ? 'checked' : ''}>${esc(S('offset'))}</label>` +
      `<label title="${esc(S('dumpToggleTitle'))}"><input type="checkbox" id="showDump" ${state.showDump ? 'checked' : ''}>${esc(S('dumpToggle'))}</label>` +
      `<button id="compare" title="${esc(S('compareTitle'))}">${esc(S('compare'))}</button>` +
      `<button id="exportAll" title="${esc(S('exportAllTitle'))}">${esc(S('exportAll'))}</button>` +
      `<label>${esc(S('encoding'))} <select id="enc">${d.encodings
        .map((e) => `<option value="${e}" ${e === d.encoding ? 'selected' : ''}>${e}</option>`)
        .join('')}</select></label>`;
    document.getElementById('hideFiller').onchange = (ev) => {
      state.hideFiller = ev.target.checked;
      resetView(true);
    };
    document.getElementById('exportAll').onclick = () => vscode.postMessage({ type: 'exportAll' });
    document.getElementById('showOffset').onchange = (ev) => {
      state.showOffset = ev.target.checked;
      saveState();
      resetView(true);
    };
    document.getElementById('compare').onclick = () => vscode.postMessage({ type: 'compare' });
    document.getElementById('showDump').onchange = (ev) => {
      state.showDump = ev.target.checked;
      saveState();
      renderDump();
      if (state.showDump && state.selected && state.selEntry !== undefined) requestDump(state.selEntry);
    };
    document.getElementById('autoPacked').onchange = (ev) => {
      vscode.postMessage({ type: 'setAutoPacked', on: ev.target.checked });
    };
    document.getElementById('enc').onchange = (ev) => {
      vscode.postMessage({ type: 'setEncoding', encoding: ev.target.value });
    };
  }

  function renderTabs() {
    const d = state.init;
    const parts = d.groups.map((g) => {
      const cb = g.copybookName
        ? `<span class="cb" title="${esc(g.copybookName)}">✔ ${esc(g.copybookName)}</span>` +
          (g.auto ? ` <span class="auto" title="${esc(S('autoTagTitle'))}">${esc(S('autoTag'))}</span>` : '')
        : `<span class="nocb">${esc(S('noCopybook'))}</span>`;
      const val = g.value !== null ? ` <span class="dv" title="${esc(g.discLabel || '')}">= ${esc(g.value)}</span>` : '';
      return `<button class="tab ${state.view === g.key ? 'active' : ''}" data-v="${esc(g.key)}"><span class="gdot${groupColor(g.key)}"></span>${esc(S('bytes', { n: g.length }))}${val} <small>× ${g.count}</small>${cb}</button>`;
    });
    if (d.errorCount) {
      parts.push(
        `<button class="tab errtab ${state.view === ERR_VIEW ? 'active' : ''}" data-v="${ERR_VIEW}">${esc(S('errorTab'))} <small>× ${d.errorCount}</small></button>`
      );
    }
    parts.push(
      `<button class="tab ordertab ${state.view === ORDER_VIEW ? 'active' : ''}" data-v="${ORDER_VIEW}" title="${esc(S('orderTabTitle'))}">${esc(S('orderTab'))}</button>`
    );
    $tabs.innerHTML = parts.join('');
    $tabs.querySelectorAll('.tab').forEach((b) => {
      b.onclick = () => {
        if (state.view !== b.dataset.v) {
          state.view = b.dataset.v;
          state.selected = null;
          state.dump = null;
          clearCellbar();
          renderDump();
          resetView(false);
        }
      };
    });
  }

  function renderBanner() {
    const d = state.init;
    let level = 'info';
    let text = '';
    let buttons = '';
    /** 「⋯」菜单中的操作 */
    const more = [];
    const g = groupOf(state.view);
    if (state.view === ORDER_VIEW) {
      const unmapped = d.groups.filter((x) => !x.copybookName).length;
      level = unmapped || d.errorCount ? 'warn' : 'info';
      text =
        S('orderBanner', { n: d.groups.length }) +
        (unmapped ? S('orderUnmapped', { n: unmapped }) : '') +
        (d.errorCount ? S('orderErrors', { n: d.errorCount }) : '') +
        S('period');
    } else if (state.view === ERR_VIEW) {
      level = 'error';
      text = S('errBanner', { n: d.errorCount });
      buttons = `<button data-act="export" title="${esc(S('exportTitle'))}">${esc(S('export'))}</button>`;
    } else {
      level = g.banner.level;
      text = g.banner.text;
      // COPY句未指定のときだけ主ボタン
      buttons = `<button class="${g.copybookName ? '' : 'primary'}" data-act="choose">${esc(S(g.copybookName ? 'change' : 'choose'))}</button>`;
      buttons += `<button data-act="export" title="${esc(S('exportTitle'))}">${esc(S('export'))}</button>`;
      if (g.copybookName) more.push({ act: 'detail', label: S('detail'), title: S('detailTitle') });
      if (g.copybookName || g.banner.level === 'error') more.push({ act: 'clear', label: S('clear') });
      more.push(g.value === null ? { act: 'disc', label: S('disc'), title: S('discTitle') } : { act: 'undisc', label: S('undisc') });
      buttons += `<button class="icon" data-act="more" title="${esc(S('moreTitle'))}">⋯</button>`;
    }
    const icon = { info: 'ℹ', warn: '⚠', error: '✖' }[level];
    $banner.className = level;
    $banner.innerHTML = `<span class="ico">${icon}</span><span class="text" title="${esc(text)}">${esc(text)}</span>${buttons}`;
    const run = (act) => {
      if (act === 'export') {
        vscode.postMessage({ type: 'exportView', view: state.view });
        return;
      }
      if (!g) return;
      const type = {
        choose: 'chooseCopybook',
        clear: 'clearCopybook',
        detail: 'showLayout',
        disc: 'configureDisc',
        undisc: 'clearDisc',
      }[act];
      vscode.postMessage({ type, g: g.key });
    };
    $banner.querySelectorAll('button').forEach((b) => {
      b.onclick = () => (b.dataset.act === 'more' ? openMenu(b, more, run) : run(b.dataset.act));
    });
  }

  function closeMenu() {
    $menu.style.display = 'none';
  }
  function openMenu(anchor, items, run) {
    if ($menu.style.display === 'block') {
      closeMenu();
      return;
    }
    $menu.innerHTML = items
      .map((it, i) => `<div class="mi" data-i="${i}" title="${esc(it.title || '')}">${esc(it.label)}</div>`)
      .join('');
    $menu.style.display = 'block';
    const r = anchor.getBoundingClientRect();
    $menu.style.top = r.bottom + 2 + 'px';
    $menu.style.right = Math.max(4, window.innerWidth - r.right) + 'px';
    $menu.onclick = (ev) => {
      const el = ev.target.closest('.mi');
      if (!el) return;
      closeMenu();
      run(items[Number(el.dataset.i)].act);
    };
  }
  document.addEventListener('mousedown', (ev) => {
    if (!$menu.contains(ev.target) && !ev.target.closest('[data-act="more"]')) closeMenu();
  });
  window.addEventListener('blur', closeMenu);

  /** REDEFINES / 01 记录的布局切换（当前分组标签页） */
  function renderLayouts() {
    const g = state.view !== ORDER_VIEW && state.view !== ERR_VIEW ? groupOf(state.view) : null;
    const choices = (g && g.choices) || [];
    if (!choices.length) {
      $layouts.innerHTML = '';
      $layouts.style.display = 'none';
      return;
    }
    $layouts.style.display = '';
    $layouts.innerHTML =
      `<span class="lt" title="${esc(S('layoutTitle'))}">${esc(S('layout'))}</span>` +
      choices
        .map((c, i) => {
          const label = c.id === '01' ? S('layoutRecord') : `REDEFINES ${c.base}`;
          const opts = c.options
            .map((o) => `<option value="${esc(o)}" ${o === c.selected ? 'selected' : ''}>${esc(o)}</option>`)
            .join('');
          return `<label title="${esc(c.id)}">${esc(label)} <select data-i="${i}">${opts}</select></label>`;
        })
        .join('');
    $layouts.querySelectorAll('select').forEach((sel) => {
      sel.onchange = () => {
        const c = choices[Number(sel.dataset.i)];
        vscode.postMessage({ type: 'setLayout', g: g.key, id: c.id, option: sel.value });
      };
    });
  }

  function clearCellbar() {
    $cellbar.innerHTML = `<span class="hint">${esc(S('cellHint'))}</span>`;
  }

  function applyLayout(root) {
    C.applyLayout(root, viewWidth());
  }

  /* ---------- 表头 ---------- */
  /* ---------- 显示样式 ---------- */
  const GROUP_COLORS = 6;
  /** 分组的配色编号（文件顺序视图的色条、标签页的圆点） */
  function groupColor(key) {
    const i = state.init ? state.init.groups.findIndex((g) => g.key === key) : -1;
    return i < 0 ? '' : ` gc${i % GROUP_COLORS}`;
  }
  const FILLER_RE = C.FILLER_RE;
  const cellHtml = C.cellHtml;
  const plainSeg = C.plainSeg;

  function headerRowHtml(key, k, isAbs, top) {
    const { vis } = visibleCols(key);
    const label = key === ERR_VIEW ? '#' : [S('hdrName'), S('hdrPic'), S('hdrPos')][k].replace(/ /g, '');
    const gc = state.view === ORDER_VIEW ? groupColor(key) : '';
    let html = `<div class="row hdrrow k${k}${gc}" ${isAbs ? `data-top="${top}"` : ''}>`;
    html += `<div class="c l lh hd">${label}</div>`;
    return html + C.headerCells(vis, k) + '</div>';
  }

  function renderStaticHeader() {
    if (state.view === ORDER_VIEW) {
      $hdr.style.display = 'none';
      $hdr.innerHTML = '';
      return;
    }
    $hdr.style.display = '';
    $hdr.style.width = viewWidth();
    const rows = [];
    for (let k = 0; k < hdrRowsOf(state.view); k++) rows.push(headerRowHtml(state.view, k, false));
    $hdr.innerHTML = rows.join('');
    applyLayout($hdr);
  }

  /* ---------- 行 ---------- */
  function rowHtml(row, i, view) {
    const top = i * ROW_H;
    if (row.t === 'hdr') {
      return headerRowHtml(row.g, row.k, true, top);
    }
    const isErr = row.t === 'err';
    const key = isErr ? ERR_VIEW : row.g;
    const { vis } = visibleCols(key);
    const warn = !isErr && row.w.length > 0;
    const status = isErr ? '<span class="st-err">✖</span>' : warn ? '<span class="st-warn">⚠</span>' : '';
    const selRow = state.selected && state.selected.view === view && state.selected.row === i ? ' selrow' : '';
    const gc = view === ORDER_VIEW && !isErr ? groupColor(row.g) : '';
    let html = `<div class="row${isErr ? ' err' : ''}${i % 2 ? ' odd' : ''}${selRow}${gc}" data-top="${top}">`;
    html += `<div class="c l l0">${row.e + 1}</div>`;
    if (state.showOffset) {
      html += `<div class="c l l1" title="${esc(S('offset'))} ${row.o}">0x${row.o.toString(16).toUpperCase().padStart(8, '0')}</div>`;
    }
    html += `<div class="c l l2">${status}</div>`;
    const warnSet = isErr ? null : new Set(row.w);
    for (const { i: ci, col, px } of vis) {
      const text = row.c[ci];
      const isW = warnSet && warnSet.has(ci);
      const sel =
        state.selected && state.selected.view === view && state.selected.row === i && state.selected.col === ci ? ' sel' : '';
      const num = isNumeric(col) && col.kind !== 'missing' ? ' num' : '';
      const dim = FILLER_RE.test(col.name) || col.kind === 'extra' ? ' dim' : '';
      const blank = !isErr && text.trim() === '' ? ' blank' : '';
      const body = isErr ? esc(text) : cellHtml(text, col);
      html += `<div class="c f${isW ? ' w' : ''}${sel}${num}${dim}${blank}" data-w="${px}" data-r="${i}" data-c="${ci}" title="${esc(plainSeg(text))}">${body}</div>`;
    }
    return html + '</div>';
  }

  function cacheFor(view) {
    let m = state.cache.get(view);
    if (!m) {
      m = new Map();
      state.cache.set(view, m);
    }
    return m;
  }

  function requestBlock(view, b) {
    const m = cacheFor(view);
    if (m.has(b)) return;
    m.set(b, 'pending');
    vscode.postMessage({ type: 'getRows', gen: state.gen, view, start: b * BLOCK, count: BLOCK });
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
    if (!state.init || !state.view) return;
    const view = state.view;
    const n = viewCount(view);
    const hdrH = hdrRowsOf(view) * ROW_H;
    const top = $scroller.scrollTop;
    const first = Math.max(0, Math.floor((top - hdrH) / ROW_H) - 3);
    const last = Math.min(n - 1, Math.ceil((top + $scroller.clientHeight - hdrH) / ROW_H) + 3);
    const m = cacheFor(view);
    let html = '';
    for (let i = first; i <= last; i++) {
      const b = Math.floor(i / BLOCK);
      const block = m.get(b);
      if (!block) {
        requestBlock(view, b);
        continue;
      }
      if (block === 'pending') continue;
      const row = block[i - b * BLOCK];
      if (row) html += rowHtml(row, i, view);
    }
    $rows.innerHTML = html;
    applyLayout($rows);
  }

  function resetView(keepScroll) {
    const st = keepScroll ? $scroller.scrollTop : 0;
    colCache.clear();
    if (!keepScroll) {
      $scroller.scrollTop = 0;
      $scroller.scrollLeft = 0;
    }
    const n = viewCount(state.view);
    $inner.style.width = viewWidth();
    $rows.style.height = n * ROW_H + 'px';
    renderTabs();
    $scroller.classList.toggle('order', state.view === ORDER_VIEW);
    $scroller.classList.toggle('nooff', !state.showOffset);
    renderBanner();
    renderLayouts();
    renderStaticHeader();
    if (n === 0) {
      $rows.innerHTML = `<div id="empty">${esc(S('empty'))}</div>`;
    } else {
      $scroller.scrollTop = st;
      draw();
    }
  }

  /* ---------- 十六进制 dump ---------- */
  function requestDump(entry) {
    if (state.showDump) vscode.postMessage({ type: 'dump', e: entry });
  }

  function renderDump() {
    $split.style.display = state.showDump ? '' : 'none';
    $dump.style.display = state.showDump ? '' : 'none';
    if (!state.showDump) return;
    const d = state.dump;
    const selCol = d && state.selected && state.selEntry === d.entry ? state.selected.col : undefined;
    $dump.innerHTML = C.dumpHtml(d, { selCol, empty: S('dumpEmptyHint') });
    C.applyLayout($dump);
  }

  /** dump 中点击了某个字段的字节：选中表格中同一条记录的对应单元格 */
  function pickColumn(col) {
    const sel = state.selected;
    if (!sel || !state.dump || state.dump.groupKey === null) return;
    state.selected = { view: sel.view, row: sel.row, col };
    vscode.postMessage({ type: 'cellInfo', g: state.dump.groupKey, e: state.dump.entry, col });
    draw();
    renderDump();
    const el = $rows.querySelector('.c.f.sel');
    if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  C.splitter($split, $dump, state.dumpH, (h) => {
    state.dumpH = h;
    saveState();
  });
  C.bindDump($dump, () => state.dump, pickColumn);

  /* ---------- 事件 ---------- */
  C.refreshMetrics($scroller);
  $scroller.addEventListener('scroll', scheduleDraw, { passive: true });
  window.addEventListener('resize', scheduleDraw);

  $rows.addEventListener('click', (ev) => {
    const el = ev.target.closest('.c.f');
    if (!el) return;
    const rowIdx = Number(el.dataset.r);
    const colIdx = Number(el.dataset.c);
    const view = state.view;
    const b = Math.floor(rowIdx / BLOCK);
    const block = cacheFor(view).get(b);
    if (!block || block === 'pending') return;
    const row = block[rowIdx - b * BLOCK];
    if (!row || row.t === 'hdr') return;
    state.selected = { view, row: rowIdx, col: colIdx };
    state.selRec = `<span class="rec" title="${esc(S('offset'))} ${row.o}">#${row.e + 1} · 0x${row.o.toString(16).toUpperCase().padStart(8, '0')}</span>`;
    const sameEntry = state.dump && state.selEntry === row.e;
    state.selEntry = row.e;
    if (sameEntry) renderDump();
    else requestDump(row.e);
    if (row.t === 'err') {
      $cellbar.innerHTML = state.selRec + `<span class="name">${esc(ERR_COLUMNS[colIdx].name)}</span><span class="value">${esc(row.c[colIdx])}</span>`;
    } else {
      vscode.postMessage({ type: 'cellInfo', g: row.g, e: row.e, col: colIdx });
    }
    draw();
  });

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    switch (msg.type) {
      case 'init': {
        C.refreshMetrics($scroller);
        C.setStrings(msg.strings);
        localizeErrColumns();
        state.init = msg;
        state.gen = msg.gen;
        state.cache.clear();
        state.selected = null;
        hideRegex = C.compileHide(msg.hiddenPattern);
        const keys = msg.groups.map((g) => g.key).concat([ERR_VIEW, ORDER_VIEW]);
        const keep = state.view && keys.includes(state.view);
        if (!keep) {
          state.view = msg.groups.length ? msg.groups[0].key : msg.errorCount ? ERR_VIEW : ORDER_VIEW;
        }
        clearCellbar();
        state.dump = null;
        renderDump();
        renderToolbar();
        resetView(keep);
        break;
      }
      case 'rows': {
        if (msg.gen !== state.gen) return;
        const m = cacheFor(msg.view);
        m.set(msg.start / BLOCK, msg.rows);
        if (msg.view === state.view) scheduleDraw();
        break;
      }
      case 'dump': {
        if (!state.selected || msg.info === null || msg.info.entry !== state.selEntry) return;
        state.dump = msg.info;
        renderDump();
        break;
      }
      case 'cell': {
        const c = msg.info;
        if (!c) return;
        $cellbar.innerHTML =
          (state.selRec || '') +
          `<span class="name" title="${esc(c.name)}">${esc(c.name)}</span>` +
          `<span class="value ${c.warn ? 'warn' : ''}">${esc(c.text)}</span>` +
          (c.value ? `<span class="num">${esc(S('cellValue', { value: c.value }))}</span>` : '') +
          `<span class="hint">${esc(S('cellMeta', { pic: c.pic, pos: c.start, len: c.len }))}</span>` +
          `<span class="hex" title="${esc(c.hex)}">${esc(c.hex)}</span>`;
        break;
      }
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
