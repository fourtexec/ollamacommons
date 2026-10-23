const grid = document.getElementById('server-grid');
const searchInput = document.getElementById('search-input');
const filterToggle = document.getElementById('filter-toggle');
const resultsCount = document.getElementById('results-count');
const modelSearchResults = document.getElementById('model-search-results');
const toastEl = document.getElementById('toast');
let servers = [];
let freeOnly = true;
let toastTimer;

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function parseServersYaml(text) {
  const result = [];
  let current = null;
  let activeArray = null;
  const parseValue = raw => {
    const value = raw.trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      return value.slice(1, -1).split(',').map(item => item.trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_, dq, sq) => dq ?? sq)).filter(Boolean);
    }
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_, dq, sq) => dq ?? sq);
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line === 'servers:') continue;
    if (/^-\s+id\s*:/.test(line)) {
      if (current) result.push(current);
      current = {};
      activeArray = null;
      const pair = line.slice(2).trim();
      const colon = pair.indexOf(':');
      current[pair.slice(0, colon).trim()] = parseValue(pair.slice(colon + 1));
      continue;
    }
    if (!current) continue;
    if (line.startsWith('- ') && activeArray) {
      current[activeArray].push(parseValue(line.slice(2)));
      continue;
    }
    const colon = line.indexOf(':');
    if (colon > 0) {
      const key = line.slice(0, colon).trim();
      const rawValue = line.slice(colon + 1).trim();
      if (!rawValue) {
        current[key] = [];
        activeArray = key;
      } else {
        current[key] = parseValue(rawValue);
        activeArray = null;
      }
    }
  }
  if (current) result.push(current);
  if (result.some(server => !server.id || !server.name || !server.url)) throw new Error('An entry in servers.yaml is missing id, name, or url.');
  return result.map(server => ({
    ...server,
    tags: Array.isArray(server.tags) ? server.tags : [],
    models: Array.isArray(server.models) ? server.models : [],
    free: server.free !== false,
    featured: server.featured === true,
    example: server.example === true
  }));
}

function getListedModels(server) {
  return server.models.map(model => {
    if (typeof model === 'string') return { name: model };
    if (!model || typeof model !== 'object') return null;
    const name = model.name || model.id || model.model;
    return name ? { ...model, name: String(name) } : null;
  }).filter(Boolean);
}
function openAIBaseUrl(url) {
  const base = String(url || '').replace(/\/+$/, '');
  return /\/v1$/i.test(base) ? `${base}/` : `${base}/v1/`;
}
function showToast(message) {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2800);
}
function renderModelSearch(query) {
  if (!query) {
    modelSearchResults.hidden = true;
    modelSearchResults.innerHTML = '';
    return;
  }
  const matches = servers.flatMap(server => getListedModels(server)
    .filter(model => model.name.toLowerCase().includes(query))
    .map(model => ({ server, model })));
  modelSearchResults.hidden = false;
  modelSearchResults.innerHTML = `
    <div class="model-results-heading"><span class="section-kicker">MODEL MATCHES</span><strong>${matches.length} result${matches.length === 1 ? '' : 's'}</strong></div>
    ${matches.length ? `<div class="model-results-list">${matches.map(({ server, model }) => `
      <div class="model-result-row">
        <div class="model-result-name"><strong>${esc(model.name)}</strong><small>${esc(server.name)} · ${esc(server.region || 'Unknown region')}</small></div>
        <button class="model-result-copy" type="button" data-url="${esc(openAIBaseUrl(server.url))}">Copy /v1/ URL</button>
      </div>`).join('')}</div>` : '<p class="model-no-results">No model names matched. Matching server cards, if any, are shown below.</p>'}`;
  modelSearchResults.querySelectorAll('.model-result-copy').forEach(button => button.addEventListener('click', () => copyUrl(button.dataset.url)));
}
function render() {
  const query = searchInput.value.trim().toLowerCase();
  renderModelSearch(query);
  const shown = servers.filter(server => {
    const searchable = `${server.name} ${server.description || ''} ${server.region || ''} ${server.tags.join(' ')} ${getListedModels(server).map(m => m.name).join(' ')}`.toLowerCase();
    return (!freeOnly || server.free) && (!query || searchable.includes(query));
  }).sort((a, b) => Number(b.featured) - Number(a.featured));
  resultsCount.textContent = `${shown.length} server${shown.length === 1 ? '' : 's'} shown · ${servers.length} total`;
  document.getElementById('hero-server-count').textContent = String(servers.length).padStart(2, '0');
  if (!shown.length) {
    grid.innerHTML = '<div class="empty-state"><strong>No matching servers</strong>Try another search, or review the YAML example below.</div>';
    return;
  }
  grid.innerHTML = shown.map(server => {
    const models = getListedModels(server);
    const tags = server.tags.slice(0, 3).map(tag => `<span class="tag">${esc(tag)}</span>`).join('');
    const modelItems = models.length
      ? models.map(model => `<span class="model-pill">${esc(model.name)}</span>`).join('')
      : '<span class="models-empty">No model names are listed in the YAML.</span>';
    return `<article class="server-card">
      <div class="card-top"><span class="region-label"><span class="region-icon">⌖</span>${esc(server.region || 'Unknown region')}</span><span class="badges">${server.free ? '<i class="badge free">FREE</i>' : ''}${server.example ? '<i class="badge example">EXAMPLE</i>' : ''}</span></div>
      <div class="card-title"><h3>${esc(server.name)}</h3></div>
      <p class="card-desc">${esc(server.description || 'Ollama-compatible server endpoint.')}</p>
      <div class="endpoint-line"><span>↗</span><code>${esc(openAIBaseUrl(server.url))}</code><button class="endpoint-copy" data-url="${esc(openAIBaseUrl(server.url))}" type="button">Copy</button></div>
      <div class="tag-list">${tags}</div>
      <div class="card-bottom"><span class="model-summary"><strong>${models.length} model${models.length === 1 ? '' : 's'} listed</strong></span><button class="card-button list-models-button" type="button" aria-expanded="false">List models</button></div>
      <div class="card-model-list" hidden>${modelItems}</div>
    </article>`;
  }).join('');
  grid.querySelectorAll('.list-models-button').forEach(button => button.addEventListener('click', () => {
    const panel = button.closest('.server-card').querySelector('.card-model-list');
    const expanded = button.getAttribute('aria-expanded') === 'true';
    panel.hidden = expanded;
    button.setAttribute('aria-expanded', String(!expanded));
    button.textContent = expanded ? 'List models' : 'Hide models';
  }));
  grid.querySelectorAll('.endpoint-copy').forEach(button => button.addEventListener('click', () => copyUrl(button.dataset.url)));
}
async function copyUrl(url) {
  try { await navigator.clipboard.writeText(url); showToast('OpenAI-compatible /v1/ URL copied'); }
  catch { showToast(`Copy this URL: ${url}`); }
}

searchInput.addEventListener('input', render);
filterToggle.addEventListener('click', () => {
  freeOnly = !freeOnly;
  filterToggle.classList.toggle('is-off', !freeOnly);
  render();
});
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    searchInput.focus();
  }
});
document.getElementById('copy-config').addEventListener('click', async event => {
  const yaml = `servers:\n  - id: my-ollama\n    name: My Ollama Server\n    url: https://ollama.example.com\n    region: US East\n    free: true\n    tags: [community, gpu]\n    models: [llama3.2:latest]`;
  try {
    await navigator.clipboard.writeText(yaml);
    event.currentTarget.innerHTML = 'Copied! <span>✓</span>';
    setTimeout(() => event.currentTarget.innerHTML = 'Copy example <span>▢</span>', 1600);
  } catch { showToast('Clipboard unavailable. Copy the example from servers.yaml instead.'); }
});

fetch('https://ollama.fourtexec.site/servers.yaml', { cache: 'no-store' }).then(async response => {
  if (!response.ok) throw new Error(`Could not load remote servers.yaml (${response.status})`);
  return response.text();
}).then(text => { servers = parseServersYaml(text); render(); }).catch(error => {
  grid.innerHTML = `<div class="empty-state"><strong>Couldn’t load remote servers.yaml</strong>${esc(error.message)}<br>Verify the remote YAML and reload.</div>`;
  resultsCount.textContent = 'Directory unavailable';
});
