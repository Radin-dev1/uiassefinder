const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

let config = null;
let settings = store.get('uaf.settings', { ai: { provider: 'anthropic', key: '', model: 'claude-sonnet-5-5', baseUrl: '' }, search: { provider: 'serper', key: '' } });
let selectedSources = store.get('uaf.sources', ['pinterest', 'dribbble']);
let queryImage = null; // data URL

async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok || j.error) throw new Error(j.error || `HTTP ${res.status}`);
  return j;
}

// ---------------- tabs ----------------
function showView(v) {
  $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  $$('.view').forEach((s) => s.classList.toggle('active', s.id === `view-${v}`));
  if (v === 'library') loadLibrary();
}
$$('.tabs button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
$$('.subtabs button').forEach((b) =>
  b.addEventListener('click', () => {
    $$('.subtabs button').forEach((x) => x.classList.toggle('active', x === b));
    $$('.sub').forEach((s) => s.classList.toggle('active', s.id === `sub-${b.dataset.sub}`));
  })
);

// ---------------- settings ----------------
function fillSettings() {
  const p = $('#aiProvider');
  p.innerHTML = Object.entries(config.providers).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('');
  p.value = settings.ai.provider;
  $('#aiKey').value = settings.ai.key || '';
  $('#aiModel').value = settings.ai.model || '';
  $('#aiBaseUrl').value = settings.ai.baseUrl || '';
  const sp = $('#searchProvider');
  sp.innerHTML = Object.entries(config.searchProviders).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('');
  sp.value = settings.search.provider;
  $('#searchKey').value = settings.search.key || '';
  onProviderChange(false);
  onSearchProviderChange();
}

function onProviderChange(resetModel = true) {
  const prov = $('#aiProvider').value;
  $('#baseUrlWrap').hidden = prov !== 'custom';
  const models = config.providers[prov]?.models || [];
  $('#modelList').innerHTML = models.map((m) => `<option value="${esc(m)}">`).join('');
  if (resetModel) $('#aiModel').value = models[0] || '';
}
function onSearchProviderChange() {
  const sp = $('#searchProvider').value;
  $('#searchKeyWrap').hidden = sp === 'none';
  const signup = config.searchProviders[sp]?.signup;
  $('#searchSignup').innerHTML = signup ? `Get a key at <a href="${signup}" target="_blank" rel="noopener">${signup}</a>` : 'You will get one-click search links for every site instead of an image grid.';
}
$('#aiProvider').addEventListener('change', () => onProviderChange(true));
$('#searchProvider').addEventListener('change', onSearchProviderChange);

function readSettingsForm() {
  return {
    ai: { provider: $('#aiProvider').value, key: $('#aiKey').value.trim(), model: $('#aiModel').value.trim(), baseUrl: $('#aiBaseUrl').value.trim() },
    search: { provider: $('#searchProvider').value, key: $('#searchKey').value.trim() },
  };
}
$('#saveSettings').addEventListener('click', () => {
  settings = readSettingsForm();
  store.set('uaf.settings', settings);
  $('#savedMsg').textContent = 'Saved ✓';
  setTimeout(() => ($('#savedMsg').textContent = ''), 1800);
  updateKeyStatus();
});
$('#loadModels').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Loading…';
  try {
    const { models } = await api('/api/models', { ai: readSettingsForm().ai });
    $('#modelList').innerHTML = models.map((m) => `<option value="${esc(m)}">`).join('');
    btn.textContent = `${models.length} models ✓`;
    if (!$('#aiModel').value && models[0]) $('#aiModel').value = models[0];
  } catch (err) {
    alert(err.message);
    btn.textContent = 'Load models';
  } finally {
    btn.disabled = false;
  }
});

function updateKeyStatus() {
  const ok = settings.ai.model && (settings.ai.key || settings.ai.provider === 'custom');
  const el = $('#keyStatus');
  el.className = 'pill' + (ok ? ' ok' : '');
  el.textContent = ok ? `${settings.ai.model}` : 'Set up your API key →';
  el.style.cursor = 'pointer';
  el.onclick = () => showView('settings');
}

// ---------------- sources ----------------
function renderSources() {
  $('#sourceChips').innerHTML = Object.entries(config.sources)
    .map(([k, v]) => `<span class="chip ${selectedSources.includes(k) ? 'on' : ''}" data-k="${k}">${esc(v.label)}</span>`)
    .join('');
  $$('#sourceChips .chip').forEach((c) =>
    c.addEventListener('click', () => {
      const k = c.dataset.k;
      selectedSources = selectedSources.includes(k) ? selectedSources.filter((x) => x !== k) : [...selectedSources, k];
      store.set('uaf.sources', selectedSources);
      c.classList.toggle('on');
    })
  );
}

// ---------------- image input ----------------
function fileToDataUrl(file) {
  return new Promise((ok, bad) => {
    const r = new FileReader();
    r.onload = () => ok(r.result);
    r.onerror = bad;
    r.readAsDataURL(file);
  });
}
// Shrink big images so requests stay fast and within model limits.
async function downscale(dataUrl, max = 1400) {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const s = Math.min(1, max / Math.max(img.width, img.height));
  if (s === 1 && dataUrl.length < 3_000_000) return dataUrl;
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * s);
  c.height = Math.round(img.height * s);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}
async function setQueryImage(file) {
  if (!file || !file.type.startsWith('image/')) return;
  queryImage = await downscale(await fileToDataUrl(file));
  $('#dropPreview').src = queryImage;
  $('#dropPreview').hidden = false;
  $('#dropEmpty').hidden = true;
  $('#clearImage').hidden = false;
}
const drop = $('#drop');
drop.addEventListener('click', (e) => { if (e.target.id !== 'clearImage') $('#fileInput').click(); });
$('#fileInput').addEventListener('change', (e) => setQueryImage(e.target.files[0]));
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); setQueryImage(e.dataTransfer.files[0]); });
window.addEventListener('paste', (e) => {
  const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/'));
  if (f && $('#view-find').classList.contains('active')) setQueryImage(f);
});
$('#clearImage').addEventListener('click', (e) => {
  e.stopPropagation();
  queryImage = null;
  $('#dropPreview').hidden = true;
  $('#dropEmpty').hidden = false;
  $('#clearImage').hidden = true;
  $('#fileInput').value = '';
});

// ---------------- search ----------------
function setStatus(html, err = false) {
  const s = $('#status');
  s.hidden = !html;
  s.className = 'status' + (err ? ' err' : '');
  s.innerHTML = html || '';
}

$('#queryText').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) runSearch(); });
$('#searchBtn').addEventListener('click', runSearch);

async function runSearch() {
  const text = $('#queryText').value;
  if (!text.trim() && !queryImage) return setStatus('Type something, drop an image, or both.', true);
  if (!selectedSources.length) return setStatus('Pick at least one site (Pinterest, Dribbble…).', true);
  const btn = $('#searchBtn');
  btn.disabled = true;
  const steps = ['Reading your reference', 'Writing search queries', 'Searching ' + selectedSources.map((s) => config.sources[s].label).join(', '), 'Matching your examples', 'Ranking what fits'];
  let i = 0;
  setStatus(`<span class="spinner"></span>${steps[0]}…`);
  const tick = setInterval(() => { i = Math.min(i + 1, steps.length - 1); setStatus(`<span class="spinner"></span>${steps[i]}…`); }, 2500);
  try {
    const r = await api('/api/search', {
      ai: settings.ai,
      search: settings.search,
      text,
      image: queryImage,
      sources: selectedSources,
      rerank: $('#optRerank').checked,
      includeExamples: $('#optExamples').checked,
      perQuery: Number($('#optPer').value) || 10,
    });
    renderResults(r);
    setStatus(r.errors?.length ? `Done, with some issues:<br>${r.errors.map(esc).join('<br>')}` : '', !!r.errors?.length);
  } catch (e) {
    setStatus(esc(e.message), true);
  } finally {
    clearInterval(tick);
    btn.disabled = false;
  }
}

function scoreBadge(score) {
  if (score == null || Number.isNaN(score) || score === 0) return '';
  const cls = score >= 70 ? '' : score >= 45 ? 'mid' : 'low';
  return `<span class="score ${cls}">${Math.round(score)}%</span>`;
}

function webCard(r) {
  const label = config.sources[r.source]?.label || r.domain;
  return `<div class="item">
    <span class="badge">${esc(label)}</span>${scoreBadge(r.score)}
    <img loading="lazy" referrerpolicy="no-referrer" src="${esc(r.thumb || r.image)}" data-full="${esc(r.image)}" data-page="${esc(r.page || r.image)}" data-title="${esc(r.title)}" onerror="this.src='${esc(r.image)}';this.onerror=null" />
    <div class="meta">
      <div class="title">${esc(r.title || r.domain)}</div>
      ${r.reason ? `<div class="why">${esc(r.reason)}</div>` : ''}
      <div class="acts">
        <a href="${esc(r.page || r.image)}" target="_blank" rel="noopener">Open ↗</a>
        <a href="${esc(r.image)}" target="_blank" rel="noopener">Image</a>
        <button data-save="${esc(r.image)}" data-name="${esc((r.title || r.domain || 'asset').slice(0, 50))}">+ Examples</button>
      </div>
    </div></div>`;
}

function exCard(it, showWhy = true) {
  const src = `/examples/${it.file.split('/').map(encodeURIComponent).join('/')}`;
  return `<div class="item">
    ${it.folder ? `<span class="badge">${esc(it.folder)}</span>` : ''}
    ${showWhy ? scoreBadge(it.score) : it.indexed ? '' : '<span class="unindexed">not indexed</span>'}
    <img loading="lazy" src="${src}" data-full="${src}" data-page="${src}" data-title="${esc(it.file)}" />
    <div class="meta">
      <div class="title">${esc(it.file.split('/').pop())}</div>
      <div class="why">${esc(showWhy && it.reason ? it.reason : it.description)}</div>
      ${!showWhy && it.tags?.length ? `<div class="row wrap" style="margin-top:6px;gap:4px">${it.tags.slice(0, 8).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
    </div></div>`;
}

function renderResults(r) {
  $('#results').hidden = false;
  const a = r.analysis || {};
  $('#analysisDesc').textContent = a.description || '';
  $('#swatches').innerHTML = (a.colors || []).filter((c) => /^#[0-9a-f]{3,8}$/i.test(c)).map((c) => `<i title="${c}" style="background:${c}"></i>`).join('');
  $('#analysisTags').innerHTML = (a.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('');
  $('#analysisQueries').innerHTML = (a.queries || []).map((q) => `<span class="qtag">🔎 ${esc(q)}</span>`).join('');

  $('#cntWeb').textContent = r.web.length ? `(${r.web.length})` : '';
  $('#cntEx').textContent = r.examples.length ? `(${r.examples.length})` : '';
  $('#gridWeb').innerHTML = r.web.length
    ? r.web.map(webCard).join('')
    : `<div class="empty">${settings.search.provider === 'none' ? 'No search key set, so use the "Open on sites" tab, or add a search key in Settings to get images here.' : 'No web images found. Try other sites or wording.'}</div>`;
  $('#gridEx').innerHTML = r.examples.length
    ? r.examples.map((x) => exCard(x, true)).join('')
    : '<div class="empty">No matches in your examples folder. Add images on the "My examples" tab and index them.</div>';
  $('#linkList').innerHTML = r.links
    .map((g) => `<div class="card"><h3>${esc(g.label)}</h3>${g.links.map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.query)} ↗</a>`).join('')}</div>`)
    .join('');

  const firstTab = r.web.length ? 'web' : r.examples.length ? 'ex' : 'links';
  $(`.subtabs button[data-sub="${firstTab}"]`).click();
}

// Save web result into examples folder
document.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-save]');
  if (!b) return;
  b.disabled = true;
  b.textContent = 'Saving…';
  try {
    await api('/api/examples/save-url', { url: b.dataset.save, name: b.dataset.name });
    b.textContent = 'Saved ✓';
  } catch (err) {
    b.textContent = 'Failed';
    b.title = err.message;
    b.disabled = false;
  }
});

// Lightbox
document.addEventListener('click', (e) => {
  const img = e.target.closest('.item img');
  if (!img) return;
  $('#lbImg').src = img.dataset.full || img.src;
  $('#lbTitle').textContent = img.dataset.title || '';
  $('#lbOpen').href = img.dataset.page || img.src;
  $('#lightbox').hidden = false;
});
$('#lightbox').addEventListener('click', (e) => { if (e.target.id !== 'lbOpen') $('#lightbox').hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#lightbox').hidden = true; });

// ---------------- library ----------------
let libItems = [];
async function loadLibrary() {
  try {
    const { items, dir } = await api('/api/examples');
    libItems = items;
    $('#exDir').textContent = dir;
    renderLibrary();
  } catch (e) {
    $('#exStats').textContent = e.message;
  }
}
function renderLibrary() {
  const f = $('#exFilter').value.toLowerCase().trim();
  const list = f ? libItems.filter((i) => `${i.file} ${i.description} ${i.tags.join(' ')}`.toLowerCase().includes(f)) : libItems;
  const un = libItems.filter((i) => !i.indexed).length;
  $('#exStats').textContent = `${libItems.length} images · ${libItems.length - un} indexed · ${un} waiting to be indexed`;
  $('#gridLib').innerHTML = list.length ? list.map((x) => exCard(x, false)).join('') : '<div class="empty">No images yet. Upload some or drop them in the folder above.</div>';
}
$('#exFilter').addEventListener('input', renderLibrary);
$('#refreshEx').addEventListener('click', loadLibrary);
$('#uploadInput').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  if (!files.length) return;
  $('#exStats').textContent = `Uploading ${files.length}…`;
  try {
    const payload = await Promise.all(files.map(async (f) => ({ name: f.name, dataUrl: await fileToDataUrl(f) })));
    await api('/api/examples/upload', { files: payload, folder: $('#uploadFolder').value.trim() });
  } catch (err) {
    alert(err.message);
  }
  e.target.value = '';
  loadLibrary();
});
$('#indexBtn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const waiting = libItems.filter((i) => !i.indexed).length;
  if (!waiting) return ($('#exStats').textContent = 'Everything is already indexed ✓');
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span>Indexing ${waiting}…`;
  try {
    const r = await api('/api/examples/index', { ai: settings.ai });
    if (r.errors.length) alert(`Indexed ${r.indexed}/${r.total}. Problems:\n${r.errors.slice(0, 8).join('\n')}`);
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Index new images';
    loadLibrary();
  }
});

// ---------------- boot ----------------
(async function boot() {
  config = await api('/api/config');
  selectedSources = selectedSources.filter((s) => config.sources[s]);
  fillSettings();
  renderSources();
  updateKeyStatus();
  if (!settings.ai.key && settings.ai.provider !== 'custom') showView('settings');
})();
