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
  const LEFT_W = 26; // ch：序号 8 + 偏移 14 + 状态 4
  const ERR_VIEW = 'ERR';
  const ORDER_VIEW = 'ORDER';
  /** 界面文字（随 init 消息由扩展端按 VS Code 的显示语言发来） */
  let strings = {};
  function S(key, args) {
    const text = strings[key] !== undefined ? strings[key] : key;
    return text.replace(/\{(\w+)\}/g, (m, k) => (args && k in args ? String(args[k]) : m));
  }
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
  };

  /* ---------- DOM ---------- */
  const app = document.getElementById('app');
  app.innerHTML = [
    '<div id="toolbar"></div>',
    '<div id="tabs"></div>',
    '<div id="banner"></div>',
    '<div id="layouts"></div>',
    '<div id="cellbar"></div>',
    '<div id="scroller"><div id="inner"><div id="hdr"></div><div id="rows"></div></div></div>',
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

  const esc = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ---------- 列定义 ---------- */
  let hideRegex = null;

  function groupOf(key) {
    return state.init.groups.find((g) => g.key === key);
  }

  /* 列宽以 px 为单位：宽度取「host 按字节数估算的 ch 宽」和「表头文字在实际字体下的测量宽度」中较大者，
   * 这样全角表头（レコードID 等）不会因字体回退而被截断或与数据列错位。 */
  const measureCtx = document.createElement('canvas').getContext('2d');
  let chPx = 8;
  function refreshMetrics() {
    const cs = getComputedStyle($scroller);
    measureCtx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    chPx = measureCtx.measureText('0').width || 8;
  }
  function textPx(s) {
    return measureCtx.measureText(String(s)).width;
  }
  function colPx(col) {
    const header = Math.max(textPx(col.name) * 1.05, textPx(col.pic) , textPx(col.start || '')) + 14;
    return Math.ceil(Math.max(col.width * chPx, header));
  }
  const isNumeric = (col) => col.type === 'num' || col.type === 'bin';

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
      return `calc(${LEFT_W}ch + ${w}px)`;
    }
    return `calc(${LEFT_W}ch + ${visibleCols(state.view).total}px)`;
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
      `<button id="exportAll" title="${esc(S('exportAllTitle'))}">${esc(S('exportAll'))}</button>` +
      `<label>${esc(S('encoding'))} <select id="enc">${d.encodings
        .map((e) => `<option value="${e}" ${e === d.encoding ? 'selected' : ''}>${e}</option>`)
        .join('')}</select></label>`;
    document.getElementById('hideFiller').onchange = (ev) => {
      state.hideFiller = ev.target.checked;
      resetView(true);
    };
    document.getElementById('exportAll').onclick = () => vscode.postMessage({ type: 'exportAll' });
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
        ? `<span class="cb" title="${esc(g.copybookName)}">✔ ${esc(g.copybookName)}</span>`
        : `<span class="nocb">${esc(S('noCopybook'))}</span>`;
      const val = g.value !== null ? ` <span class="dv" title="${esc(g.discLabel || '')}">= ${esc(g.value)}</span>` : '';
      return `<button class="tab ${state.view === g.key ? 'active' : ''}" data-v="${esc(g.key)}">${esc(S('bytes', { n: g.length }))}${val} <small>× ${g.count}</small>${cb}</button>`;
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
          clearCellbar();
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
    if (state.view === ORDER_VIEW) {
      const unmapped = d.groups.filter((g) => !g.copybookName).length;
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
      const g = groupOf(state.view);
      level = g.banner.level;
      text = g.banner.text;
      buttons = `<button class="primary" data-act="choose">${esc(S(g.copybookName ? 'change' : 'choose'))}</button>`;
      if (g.copybookName) {
        buttons += `<button data-act="detail" title="${esc(S('detailTitle'))}">${esc(S('detail'))}</button>`;
      }
      if (g.copybookName || g.banner.level === 'error') {
        buttons += `<button data-act="clear">${esc(S('clear'))}</button>`;
      }
      buttons += `<button data-act="export" title="${esc(S('exportTitle'))}">${esc(S('export'))}</button>`;
      buttons +=
        g.value === null
          ? `<button data-act="disc" title="${esc(S('discTitle'))}">${esc(S('disc'))}</button>`
          : `<button data-act="undisc">${esc(S('undisc'))}</button>`;
    }
    $banner.className = level;
    $banner.innerHTML = `<span class="text">${esc(text)}</span>${buttons}`;
    const g = groupOf(state.view);
    $banner.querySelectorAll('button').forEach((b) => {
      b.onclick = () => {
        if (b.dataset.act === 'export') {
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
        }[b.dataset.act];
        vscode.postMessage({ type, g: g.key });
      };
    });
  }

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

  /**
   * 把 data-top / data-w 应用为实际样式。
   * Webview 的 CSP 可能禁止行内 style 属性，所以不在 HTML 里写 style="..."，而是通过 CSSOM 设置。
   */
  function applyLayout(root) {
    const vw = viewWidth();
    root.querySelectorAll('.row').forEach((r) => {
      if (r.dataset.top !== undefined) r.style.top = r.dataset.top + 'px';
      r.style.width = vw;
    });
    root.querySelectorAll('[data-w]').forEach((c) => {
      c.style.width = c.dataset.w + 'px';
    });
  }

  /* 自动识别 COMP-3 的片段标记：\uE000数值\uE001、\uE002十六进制\uE003 */
  function plainSeg(s) {
    return String(s).replace(/\uE000/g, '[').replace(/\uE001/g, ']').replace(/\uE002/g, '‹').replace(/\uE003/g, '›');
  }
  function segHtml(s) {
    return esc(s)
      .replace(/\uE000([^\uE001]*)\uE001/g, `<span class="pk" title="${esc(S('packedTitle'))}">[$1]</span>`)
      .replace(/\uE002([^\uE003]*)\uE003/g, '<span class="raw">‹$1›</span>');
  }

  /* ---------- 表头 ---------- */
  function headerRowHtml(key, k, isAbs, top) {
    const { vis } = visibleCols(key);
    const label = key === ERR_VIEW ? '#' : [S('hdrName'), S('hdrPic'), S('hdrPos')][k];
    let html = `<div class="row" ${isAbs ? `data-top="${top}"` : ''}>`;
    html += `<div class="c l lh hd">${label}</div>`;
    for (const { col, px } of vis) {
      const cls = (k === 0 ? '' : k === 1 ? ' pic' : ' pos') + (isNumeric(col) ? ' num' : '');
      const text = k === 0 ? col.name : k === 1 ? col.pic : col.start || '';
      html += `<div class="c hd${cls} ${col.kind}" data-w="${px}" title="${esc(text)}">${esc(text)}</div>`;
    }
    return html + '</div>';
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
    let html = `<div class="row ${isErr ? 'err' : ''}" data-top="${top}">`;
    html += `<div class="c l l0">${row.e + 1}</div>`;
    html += `<div class="c l l1" title="${esc(S('offset'))} ${row.o}">0x${row.o.toString(16).toUpperCase().padStart(8, '0')}</div>`;
    html += `<div class="c l l2">${status}</div>`;
    const warnSet = isErr ? null : new Set(row.w);
    for (const { i: ci, col, px } of vis) {
      const text = row.c[ci];
      const isW = warnSet && warnSet.has(ci);
      const sel =
        state.selected && state.selected.view === view && state.selected.row === i && state.selected.col === ci ? ' sel' : '';
      const num = isNumeric(col) && col.kind !== 'missing' ? ' num' : '';
      const body = col.kind === 'body' ? segHtml(text) : esc(text);
      html += `<div class="c f${isW ? ' w' : ''}${sel}${num}" data-w="${px}" data-r="${i}" data-c="${ci}" title="${esc(plainSeg(text))}">${body}</div>`;
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

  /* ---------- 事件 ---------- */
  refreshMetrics();
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
    if (row.t === 'err') {
      $cellbar.innerHTML = `<span class="name">${esc(ERR_COLUMNS[colIdx].name)}</span><span class="value">${esc(row.c[colIdx])}</span>`;
    } else {
      vscode.postMessage({ type: 'cellInfo', g: row.g, e: row.e, col: colIdx });
    }
    draw();
  });

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    switch (msg.type) {
      case 'init': {
        refreshMetrics();
        strings = msg.strings || {};
        localizeErrColumns();
        state.init = msg;
        state.gen = msg.gen;
        state.cache.clear();
        state.selected = null;
        try {
          hideRegex = msg.hiddenPattern ? new RegExp(msg.hiddenPattern, 'i') : null;
        } catch (e) {
          hideRegex = null;
        }
        const keys = msg.groups.map((g) => g.key).concat([ERR_VIEW, ORDER_VIEW]);
        const keep = state.view && keys.includes(state.view);
        if (!keep) {
          state.view = msg.groups.length ? msg.groups[0].key : msg.errorCount ? ERR_VIEW : ORDER_VIEW;
        }
        clearCellbar();
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
      case 'cell': {
        const c = msg.info;
        if (!c) return;
        $cellbar.innerHTML =
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
