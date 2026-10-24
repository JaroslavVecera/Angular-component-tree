// @ts-check
(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();

  const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
  const IDENT = /^[A-Za-z_$][\w$]*$/;
  const KINDS = [
    { key: 'inputs', label: 'Inputs', fn: 'input', typePlaceholder: 'string', canRequire: true },
    { key: 'outputs', label: 'Outputs', fn: 'output', typePlaceholder: 'void', canRequire: false },
    { key: 'models', label: 'Models', fn: 'model', typePlaceholder: 'string', canRequire: true },
  ];
  const INDENT = 14;

  const byId = (id) => /** @type {any} */ (document.getElementById(id));
  const targetEl = byId('target');
  const browseBtn = byId('browse');
  const pickBtn = byId('pick');
  const scssEl = byId('scss');
  const treeEl = byId('tree');
  const addRootBtn = byId('addRoot');
  const clearBtn = byId('clear');
  const summaryEl = byId('summary');
  const generateBtn = byId('generate');
  const statusEl = byId('status');

  let state = normalize(vscode.getState());

  // ---------- model ----------

  function normalize(s) {
    s = s || {};
    return {
      target: typeof s.target === 'string' ? s.target : '',
      style: s.style === 'css' ? 'css' : 'scss',
      tree: Array.isArray(s.tree) ? s.tree.map(normalizeNode) : [],
      selectedId: s.selectedId || null,
    };
  }

  function normalizeNode(n) {
    const props = (list) => (Array.isArray(list) ? list : []).map((p) => ({
      name: String(p.name || ''),
      type: String(p.type || ''),
      required: !!p.required,
    }));
    return {
      id: n.id || uid(),
      kind: n.kind === 'service' ? 'service' : 'component',
      name: String(n.name || ''),
      expanded: n.expanded !== false,
      inputs: props(n.inputs),
      outputs: props(n.outputs),
      models: props(n.models),
      children: Array.isArray(n.children) ? n.children.map(normalizeNode) : [],
    };
  }

  function uid() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  }

  function newNode(kind = 'component') {
    return { id: uid(), kind, name: '', expanded: true, inputs: [], outputs: [], models: [], children: [] };
  }

  const isService = (node) => node.kind === 'service';

  /** Mirrors the generator: `user-data` and `user-data-service` name the same service. */
  function serviceBase(name) {
    const trimmed = name.trim();
    return trimmed.endsWith('-service') ? trimmed.slice(0, -'-service'.length) : trimmed;
  }

  const pascal = (kebab) => kebab.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
  const serviceClass = (name) => pascal(serviceBase(name)) + 'Service';
  const serviceField = (name) => { const p = pascal(serviceBase(name)); return p.charAt(0).toLowerCase() + p.slice(1) + 'Service'; };

  /** Locates a node together with the list that holds it and its parent node. */
  function find(id, list = state.tree, parent = null) {
    for (let i = 0; i < list.length; i++) {
      const node = list[i];
      if (node.id === id) {
        return { node, list, index: i, parent };
      }
      const hit = find(id, node.children, node);
      if (hit) {
        return hit;
      }
    }
    return null;
  }

  function filledProps(node, kind) {
    return node[kind].filter((p) => p.name.trim() || p.type.trim());
  }

  function persist() {
    vscode.setState(state);
    vscode.postMessage({ type: 'state', state });
  }

  function commit(focus) {
    persist();
    render(focus);
  }

  // ---------- validation ----------

  function nameError(node, siblings, parent) {
    if (isService(node)) {
      if (!node.name.trim()) {
        return 'Zadej název service';
      }
      if (!KEBAB.test(node.name.trim()) || node.name.trim() === 'service') {
        return 'Název service musí být kebab-case (např. user-data)';
      }
      if (!parent) {
        return 'Service musí být vnořená v komponentě';
      }
      const cls = serviceClass(node.name);
      if (siblings.some((s) => s !== node && isService(s) && serviceClass(s.name) === cls)) {
        return 'Stejná service už je na této úrovni';
      }
      return '';
    }
    if (!node.name) {
      return 'Zadej název';
    }
    if (!KEBAB.test(node.name)) {
      return 'Název musí být kebab-case (např. user-detail)';
    }
    if (siblings.some((s) => s !== node && !isService(s) && s.name === node.name)) {
      return 'Stejný název už je na této úrovni';
    }
    return '';
  }

  function propError(node, prop) {
    const name = prop.name.trim();
    if (!name && !prop.type.trim()) {
      return '';
    }
    if (!IDENT.test(name)) {
      return 'Neplatný název vlastnosti';
    }
    const all = KINDS.flatMap((k) => filledProps(node, k.key));
    if (all.some((p) => p !== prop && p.name.trim() === name)) {
      return 'Duplicitní název vlastnosti';
    }
    if (node.children.some((c) => isService(c) && c.name.trim() && serviceField(c.name) === name)) {
      return 'Stejně se jmenuje injektovaná service';
    }
    return '';
  }

  function setValidity(el, message) {
    el.classList.toggle('invalid', !!message);
    el.title = message;
  }

  /** Re-checks every visible field in place, so typing never triggers a full re-render. */
  function refreshValidation() {
    let errors = 0;
    const walk = (list, parent = null) => {
      for (const node of list) {
        const message = nameError(node, list, parent);
        if (message) {
          errors++;
        }
        const el = treeEl.querySelector(nameSel(node.id));
        if (el) {
          setValidity(el, message);
        }
        for (const kind of KINDS) {
          node[kind.key].forEach((prop, i) => {
            const propMessage = propError(node, prop);
            if (propMessage) {
              errors++;
            }
            const propEl = treeEl.querySelector(propSel(node.id, kind.key, i, 'pname'));
            if (propEl) {
              setValidity(propEl, propMessage);
            }
          });
        }
        walk(node.children, node);
      }
    };
    walk(state.tree);
    updateSummary(errors);
  }

  function updateSummary(errors) {
    let count = 0;
    let services = 0;
    const walk = (list) => list.forEach((n) => {
      if (isService(n)) {
        services++;
      } else {
        count++;
      }
      walk(n.children);
    });
    walk(state.tree);

    const parts = [`${count} ${plural(count, 'komponenta', 'komponenty', 'komponent')}`];
    if (services) {
      parts.push(`${services} ${plural(services, 'service', 'servisy', 'servis')}`);
    }
    parts.push(`${count * 3 + services} souborů`);
    if (errors) {
      parts.push(`${errors} ${plural(errors, 'chyba', 'chyby', 'chyb')}`);
    }
    summaryEl.textContent = parts.join(' · ');
    summaryEl.classList.toggle('has-errors', !!errors);

    const missingTarget = !state.target.trim();
    generateBtn.disabled = !count || !!errors || missingTarget;
    generateBtn.title = missingTarget ? 'Nejdřív zadej cílovou složku' : errors ? 'Oprav chyby ve stromu' : '';
  }

  function plural(n, one, few, many) {
    return n === 1 ? one : n >= 2 && n <= 4 ? few : many;
  }

  // ---------- DOM helpers ----------

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (key === 'class') {
        el.className = value;
      } else if (key === 'dataset') {
        Object.assign(el.dataset, value);
      } else if (key.startsWith('on')) {
        el.addEventListener(key.slice(2), value);
      } else {
        el[key] = value;
      }
    }
    for (const child of children) {
      if (child != null && child !== false) {
        el.append(child);
      }
    }
    return el;
  }

  const nameSel = (id) => `input.name[data-id="${id}"]`;
  const propSel = (id, kind, index, field) =>
    `[data-id="${id}"][data-kind="${kind}"][data-index="${index}"][data-field="${field}"]`;

  function focusSelector(selector, caret) {
    const el = selector && treeEl.querySelector(selector);
    if (!el) {
      return;
    }
    el.focus();
    if (el.type === 'text') {
      const pos = caret ?? el.value.length;
      el.setSelectionRange(pos, pos);
    }
  }

  /** Delete button that asks for a second click when the action would remove more than one item. */
  function confirmButton(label, title, needsConfirm, action) {
    const btn = h('button', { class: 'icon-btn danger', title, type: 'button' }, label);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (needsConfirm() && !btn.classList.contains('confirm')) {
        btn.classList.add('confirm');
        btn.textContent = 'opravdu?';
        setTimeout(() => {
          if (btn.isConnected) {
            btn.classList.remove('confirm');
            btn.textContent = label;
          }
        }, 2500);
        return;
      }
      action();
    });
    return btn;
  }

  // ---------- rendering ----------

  function render(focus, caret) {
    treeEl.replaceChildren();
    if (!state.tree.length) {
      treeEl.append(h('div', { class: 'empty-tree' },
        'Strom je prázdný. ',
        h('button', { class: 'link-btn', type: 'button', onclick: addRoot }, 'Přidat první komponentu'),
      ));
    }
    for (const node of state.tree) {
      renderNode(node, 0, treeEl);
    }
    refreshValidation();
    focusSelector(focus, caret);
  }

  function renderNode(node, depth, container) {
    const service = isService(node);
    const selected = !service && node.id === state.selectedId;
    const row = h('div', { class: 'row' + (selected ? ' selected' : '') + (service ? ' service' : '') });
    row.style.paddingLeft = `${depth * INDENT + 2}px`;

    const twisty = h('span', { class: 'twisty' }, node.children.length ? (node.expanded ? '▾' : '▸') : '');
    twisty.addEventListener('click', (e) => {
      e.stopPropagation();
      if (node.children.length) {
        node.expanded = !node.expanded;
        commit();
      }
    });

    const nameEl = h('input', {
      class: 'name',
      type: 'text',
      value: node.name,
      placeholder: service ? 'nazev-service' : 'nazev-komponenty',
      spellcheck: false,
      dataset: { id: node.id },
    });
    nameEl.addEventListener('input', () => {
      node.name = nameEl.value;
      refreshValidation();
      persist();
    });
    nameEl.addEventListener('keydown', (e) => onNameKey(e, node, nameEl));

    let badge = null;
    if (service) {
      badge = node.name.trim() ? h('span', { class: 'hint-class' }, serviceClass(node.name)) : null;
    } else {
      const counts = KINDS.map((k) => [k.fn.charAt(0), filledProps(node, k.key).length]).filter(([, c]) => c);
      badge = counts.length
        ? h('span', { class: 'badge', title: 'inputs / outputs / models' }, counts.map(([l, c]) => `${l}${c}`).join(' '))
        : null;
    }

    const addButton = (label, title, kind) => h('button', {
      class: 'icon-btn',
      type: 'button',
      title,
      onclick: (e) => { e.stopPropagation(); addChild(node, kind); },
    }, label);

    const actions = h('span', { class: 'actions' },
      service ? '' : addButton('+', 'Přidat vnořenou komponentu', 'component'),
      service ? '' : addButton('+S', 'Přidat vnořenou service', 'service'),
      confirmButton('×', service ? 'Smazat service' : 'Smazat komponentu', () => node.children.length > 0, () => removeNode(node.id)),
    );

    row.append(twisty, h('span', { class: service ? 'icon service' : 'icon' }), nameEl, badge || '', actions);
    row.addEventListener('click', (e) => {
      const target = /** @type {HTMLElement} */ (e.target);
      if (target.closest('button') || service) {
        return;
      }
      const onInput = target === nameEl;
      if (state.selectedId === node.id) {
        if (!onInput) {
          state.selectedId = null;
          commit();
        }
        return;
      }
      state.selectedId = node.id;
      commit(onInput ? nameSel(node.id) : null, onInput ? nameEl.selectionStart : undefined);
    });
    container.append(row);

    if (selected) {
      container.append(renderDetails(node, depth));
    }
    if (node.expanded) {
      for (const child of node.children) {
        renderNode(child, depth + 1, container);
      }
    }
  }

  function renderDetails(node, depth) {
    const panel = h('div', { class: 'details' });
    panel.style.marginLeft = `${depth * INDENT + 18}px`;

    const grid = h('div', { class: 'columns' });
    for (const kind of KINDS) {
      const col = h('div', { class: 'col' },
        h('div', { class: 'col-head' },
          h('span', { class: 'col-title' }, kind.label),
          h('button', {
            class: 'icon-btn',
            type: 'button',
            title: `Přidat ${kind.fn}`,
            onclick: () => addProp(node, kind.key, node[kind.key].length),
          }, '+'),
        ),
      );
      node[kind.key].forEach((prop, i) => col.append(renderProp(node, kind, prop, i)));
      if (!node[kind.key].length) {
        col.append(h('div', { class: 'col-empty' }, 'žádné'));
      }
      grid.append(col);
    }
    panel.append(h('div', { class: 'details-head' }, h('code', {}, `<${node.name || '…'}>`)), grid);
    return panel;
  }

  function renderProp(node, kind, prop, index) {
    const data = (field) => ({ id: node.id, kind: kind.key, index: String(index), field });

    const nameEl = h('input', { class: 'pname', type: 'text', value: prop.name, placeholder: 'název', spellcheck: false, dataset: data('pname') });
    const typeEl = h('input', { class: 'ptype', type: 'text', value: prop.type, placeholder: kind.typePlaceholder, spellcheck: false, dataset: data('ptype') });
    nameEl.addEventListener('input', () => { prop.name = nameEl.value; refreshValidation(); persist(); });
    typeEl.addEventListener('input', () => { prop.type = typeEl.value; refreshValidation(); persist(); });

    const onKey = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addProp(node, kind.key, index + 1);
      } else if (e.key === 'Backspace' && e.target === nameEl && !prop.name && !prop.type) {
        e.preventDefault();
        removeProp(node, kind.key, index, true);
      }
    };
    nameEl.addEventListener('keydown', onKey);
    typeEl.addEventListener('keydown', onKey);

    let required = null;
    if (kind.canRequire) {
      const box = h('input', { type: 'checkbox', checked: !!prop.required, dataset: data('preq') });
      box.addEventListener('change', () => { prop.required = box.checked; persist(); });
      required = h('label', { class: 'req', title: `${kind.fn}.required()` }, box, 'req');
    }

    return h('div', { class: 'prop' + (kind.canRequire ? '' : ' no-req') },
      nameEl,
      typeEl,
      required || '',
      h('button', { class: 'icon-btn danger', type: 'button', title: 'Odebrat', onclick: () => removeProp(node, kind.key, index, false) }, '×'),
    );
  }

  // ---------- tree operations ----------

  function addRoot() {
    const node = newNode();
    state.tree.push(node);
    commit(nameSel(node.id));
  }

  function addChild(parent, kind) {
    const child = newNode(kind);
    parent.children.push(child);
    parent.expanded = true;
    commit(nameSel(child.id));
  }

  function removeNode(id) {
    const loc = find(id);
    if (!loc) {
      return;
    }
    loc.list.splice(loc.index, 1);
    if (state.selectedId && !find(state.selectedId)) {
      state.selectedId = null;
    }
    commit();
  }

  function visibleIds() {
    return Array.from(treeEl.querySelectorAll('input.name')).map((el) => /** @type {any} */ (el).dataset.id);
  }

  function onNameKey(e, node, nameEl) {
    const loc = find(node.id);
    if (!loc) {
      return;
    }
    const caret = nameEl.selectionStart;

    if (e.key === 'Enter') {
      e.preventDefault();
      const sibling = newNode(node.kind);
      loc.list.splice(loc.index + 1, 0, sibling);
      commit(nameSel(sibling.id));
    } else if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      // Only components can hold children, so indent under the nearest preceding component sibling.
      const prev = loc.list.slice(0, loc.index).reverse().find((s) => !isService(s));
      if (prev) {
        loc.list.splice(loc.index, 1);
        prev.children.push(node);
        prev.expanded = true;
        commit(nameSel(node.id), caret);
      }
    } else if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      const parentLoc = loc.parent && find(loc.parent.id);
      // A service cannot end up at the root, where no component would provide it.
      if (parentLoc && (!isService(node) || parentLoc.parent)) {
        loc.list.splice(loc.index, 1);
        parentLoc.list.splice(parentLoc.index + 1, 0, node);
        commit(nameSel(node.id), caret);
      }
    } else if (e.key === 'Backspace' && !node.name && !node.children.length) {
      e.preventDefault();
      const ids = visibleIds();
      const prevId = ids[ids.indexOf(node.id) - 1];
      loc.list.splice(loc.index, 1);
      if (state.selectedId === node.id) {
        state.selectedId = null;
      }
      commit(prevId ? nameSel(prevId) : null);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const ids = visibleIds();
      const next = ids[ids.indexOf(node.id) + (e.key === 'ArrowUp' ? -1 : 1)];
      if (next) {
        focusSelector(nameSel(next));
      }
    } else if (e.key === 'Escape' && state.selectedId) {
      state.selectedId = null;
      commit(nameSel(node.id), caret);
    }
  }

  function addProp(node, kind, index) {
    node[kind].splice(index, 0, { name: '', type: '', required: false });
    commit(propSel(node.id, kind, index, 'pname'));
  }

  function removeProp(node, kind, index, focusPrevious) {
    node[kind].splice(index, 1);
    let focus = null;
    if (focusPrevious) {
      focus = index > 0 ? propSel(node.id, kind, index - 1, 'ptype') : nameSel(node.id);
    }
    commit(focus);
  }

  // ---------- globals & messaging ----------

  function syncGlobals() {
    if (targetEl) {
      targetEl.value = state.target;
    }
    if (scssEl) {
      scssEl.checked = state.style === 'scss';
    }
  }

  /** Skips missing elements, so a stale or partial HTML shell never stops the rest of the panel from wiring up. */
  const on = (el, event, handler) => el?.addEventListener(event, handler);

  // ---------- target folder autocomplete ----------

  const suggestEl = byId('suggest');
  let suggestions = [];
  let activeSuggestion = -1;
  let suggestRequest = 0;

  function requestSuggestions() {
    vscode.postMessage({ type: 'suggest', value: targetEl.value, requestId: ++suggestRequest });
  }

  function renderSuggestions() {
    if (!suggestEl) {
      return;
    }
    suggestEl.replaceChildren(...suggestions.map((s, i) => {
      const item = h('div', { class: 'suggest-item' + (i === activeSuggestion ? ' active' : '') }, h('span', { class: 'suggest-icon' }), s);
      // mousedown fires before the input blurs, so the click is not lost.
      item.addEventListener('mousedown', (e) => { e.preventDefault(); acceptSuggestion(i); });
      return item;
    }));
    suggestEl.hidden = !suggestions.length || document.activeElement !== targetEl;
    suggestEl.children[activeSuggestion]?.scrollIntoView({ block: 'nearest' });
  }

  function hideSuggestions() {
    suggestions = [];
    activeSuggestion = -1;
    renderSuggestions();
  }

  function setTarget(value) {
    state.target = value;
    targetEl.value = value;
    refreshValidation();
    persist();
  }

  function acceptSuggestion(i) {
    setTarget(suggestions[i]);
    targetEl.setSelectionRange(targetEl.value.length, targetEl.value.length);
    activeSuggestion = -1;
    requestSuggestions();
  }

  on(targetEl, 'input', () => { setTarget(targetEl.value); activeSuggestion = -1; requestSuggestions(); });
  on(targetEl, 'focus', requestSuggestions);
  on(targetEl, 'blur', hideSuggestions);
  on(targetEl, 'keydown', (e) => {
    if (suggestEl?.hidden !== false) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        requestSuggestions();
      }
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      // Cycles through -1 (nothing highlighted, keep what was typed) and every suggestion.
      const states = suggestions.length + 1;
      activeSuggestion = ((activeSuggestion + 1 + step + states) % states) - 1;
      renderSuggestions();
    } else if ((e.key === 'Enter' || e.key === 'Tab') && activeSuggestion >= 0) {
      e.preventDefault();
      acceptSuggestion(activeSuggestion);
    } else if (e.key === 'Tab' && suggestions.length === 1) {
      e.preventDefault();
      acceptSuggestion(0);
    } else if (e.key === 'Escape' || e.key === 'Enter') {
      hideSuggestions();
    }
  });

  on(scssEl, 'change', () => { state.style = scssEl.checked ? 'scss' : 'css'; persist(); });
  on(browseBtn, 'click', () => vscode.postMessage({ type: 'browse' }));
  on(pickBtn, 'click', () => vscode.postMessage({ type: 'browseWorkspace' }));
  on(addRootBtn, 'click', addRoot);
  on(clearBtn, 'click', () => {
    if (!state.tree.length) {
      return;
    }
    if (!clearBtn.classList.contains('confirm')) {
      clearBtn.classList.add('confirm');
      clearBtn.textContent = 'Opravdu vymazat?';
      setTimeout(() => { clearBtn.classList.remove('confirm'); clearBtn.textContent = 'Vymazat'; }, 2500);
      return;
    }
    clearBtn.classList.remove('confirm');
    clearBtn.textContent = 'Vymazat';
    state.tree = [];
    state.selectedId = null;
    commit();
  });
  on(generateBtn, 'click', () => {
    statusEl.textContent = '';
    vscode.postMessage({ type: 'generate', state });
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'init') {
      state = normalize(msg.state);
      vscode.setState(state);
      syncGlobals();
      render();
    } else if (msg.type === 'target') {
      setTarget(msg.target);
    } else if (msg.type === 'suggestions') {
      if (msg.requestId === suggestRequest) {
        suggestions = msg.items;
        activeSuggestion = Math.min(activeSuggestion, suggestions.length - 1);
        renderSuggestions();
      }
    } else if (msg.type === 'generated') {
      statusEl.textContent = msg.message;
    }
  });

  syncGlobals();
  render();
  vscode.postMessage({ type: 'ready' });
})();
