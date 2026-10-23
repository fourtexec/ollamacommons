const grid = document.getElementById('server-grid');
const searchInput = document.getElementById('search-input');
const filterToggle = document.getElementById('filter-toggle');
const resultsCount = document.getElementById('results-count');
const toastEl = document.getElementById('toast');
const modal = document.getElementById('modal-backdrop');
const modelSelect = document.getElementById('model-select');
const chatArea = document.getElementById('chat-area');
const promptInput = document.getElementById('prompt-input');
const sendButton = document.getElementById('send-button');
let servers = [];
let freeOnly = true;
let activeServer = null;
let history = [];
let toastTimer;

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function parseServersYaml(text) {
  const result = [];
  let current = null;
  let activeArray = null;
  const parseValue = raw => {
    const value = raw.trim();
    if (value.startsWith('[') && value.endsWith(']')) return value.slice(1, -1).split(',').map(item => item.trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted)).filter(Boolean);
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted);
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
  if (result.some(server => !server.id || !server.name || !server.url)) throw new Error('Remote servers.yaml has an entry missing id, name, or url.');
  return result.map(server => ({ ...server, tags: Array.isArray(server.tags) ? server.tags : [], free: server.free !== false, featured: server.featured === true, example: server.example === true }));
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
function getListedModels(server) {
  if (!Array.isArray(server.models)) return [];
  return server.models.map(model => {
    if (typeof model === 'string') return { name: model };
    if (!model || typeof model !== 'object') return null;
    const name = model.name || model.id || model.model;
    return name ? { ...model, name: String(name) } : null;
  }).filter(Boolean);
}
function render() {
  const query = searchInput.value.trim().toLowerCase();
  const shown = servers.filter(s => {
    const modelText = getListedModels(s).map(m => m.name).join(' ');
    const searchable = `${s.name} ${s.description} ${s.region} ${(s.tags || []).join(' ')} ${modelText}`.toLowerCase();
    return (!freeOnly || s.free) && (!query || searchable.includes(query));
  }).sort((a,b) => Number(b.featured) - Number(a.featured));
  resultsCount.textContent = `${shown.length} server${shown.length === 1 ? '' : 's'} configured`;
  document.getElementById('hero-server-count').textContent = String(servers.length).padStart(2, '0');
  if (!shown.length) {
    grid.innerHTML = `<div class="empty-state"><strong>No matching servers</strong>Try another search, or add a server to your <code>servers.yaml</code> file.<br><a class="card-button" href="#setup">See the YAML example</a></div>`;
    return;
  }
  grid.innerHTML = shown.map(s => {
    const models = getListedModels(s);
    const modelCount = models.length ? `${models.length} model${models.length === 1 ? '' : 's'} listed` : 'Models not listed';
    const tags = (s.tags || []).slice(0, 3).map(t => `<span class="tag">${esc(t)}</span>`).join('');
    return `<article class="server-card">
      <div class="card-top"><span class="region-label"><span class="region-icon">⌖</span>${esc(s.region || 'Unknown region')}</span><span class="badges">${s.free ? '<i class="badge free">FREE</i>' : ''}${s.example ? '<i class="badge example">EXAMPLE</i>' : ''}</span></div>
      <div class="card-title"><h3>${esc(s.name)}</h3></div>
      <p class="card-desc">${esc(s.description || 'Ollama-compatible server endpoint.')}</p>
      <div class="endpoint-line"><span>↗</span><code>${esc(openAIBaseUrl(s.url))}</code><button class="endpoint-copy" data-url="${esc(openAIBaseUrl(s.url))}" type="button">Copy</button></div>
      <div class="tag-list">${tags}</div>
      <div class="card-bottom"><span class="model-summary"><strong>${esc(modelCount)}</strong></span><div class="card-actions"><button class="card-button primary try-button" data-id="${esc(s.id)}">Try model <span>→</span></button></div></div>
    </article>`;
  }).join('');
  grid.querySelectorAll('.try-button').forEach(button => button.addEventListener('click', () => openPlayground(button.dataset.id)));
  grid.querySelectorAll('.endpoint-copy').forEach(button => button.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(button.dataset.url); showToast('OpenAI-compatible /v1/ URL copied'); }
    catch { showToast(`Copy this URL: ${button.dataset.url}`); }
  }));
}
function serverApiUrl(server, route) {
  let base = String(server.url || '').trim().replace(/\/+$/, '');
  if (/\/v1$/i.test(base) && route.startsWith('/api/')) base = base.slice(0, -3);
  if (/\/v1$/i.test(base) && route.startsWith('/v1/')) return `${base}${route.slice(3)}`;
  return `${base}${route}`;
}
function browserAccessMessage(server, error) {
  let httpEndpoint = false;
  try { httpEndpoint = location.protocol === 'https:' && new URL(server.url).protocol === 'http:'; } catch {}
  if (httpEndpoint) return 'Browser blocked this HTTP endpoint as mixed content. Chat requires this site and Ollama to use compatible protocols and CORS settings.';
  if (error?.name === 'TypeError') return 'Browser could not read this endpoint. It must allow CORS requests from this site (and use HTTPS on an HTTPS page).';
  return error?.message || 'Could not reach this Ollama endpoint.';
}
async function fetchServerJSON(server, route, options = {}) {
  let response;
  try {
    response = await fetch(serverApiUrl(server, route), {
      ...options,
      headers: options.method ? { 'Content-Type': 'application/json', ...(options.headers || {}) } : (options.headers || {})
    });
  } catch (error) {
    const friendly = new Error(browserAccessMessage(server, error));
    friendly.status = error.status;
    throw friendly;
  }
  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { error: raw.slice(0, 300) }; }
  if (!response.ok) {
    const error = new Error(data.error || `Ollama returned HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function openPlayground(id) {
  activeServer = servers.find(s => s.id === id);
  if (!activeServer) return;
  history = [];
  const models = getListedModels(activeServer);
  document.getElementById('play-server-name').textContent = activeServer.name;
  document.getElementById('play-server-meta').textContent = `${models.length} model${models.length === 1 ? '' : 's'} listed in servers.yaml`;
  modelSelect.innerHTML = models.length
    ? models.map(m => `<option value="${esc(m.name)}">${esc(m.name)}${m.size ? ` · ${formatSize(m.size)}` : ''}</option>`).join('')
    : '<option value="">No model names are listed in servers.yaml</option>';
  modelSelect.disabled = models.length === 0;
  promptInput.disabled = models.length === 0;
  sendButton.disabled = models.length === 0;
  resetChat();
  if (!models.length) addMessage('assistant', 'This server has no models listed in the YAML. Add a models: list to its entry before using the playground.');
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  if (models.length) promptInput.focus();
}
function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes > 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}
function resetChat() {
  chatArea.innerHTML = '<div class="welcome-chat"><div class="welcome-spark">✳</div><b>A blank canvas.</b><span>Pick an installed model and ask it anything.</span></div>';
}
function addMessage(role, text, error = false) {
  chatArea.querySelector('.welcome-chat')?.remove();
  const el = document.createElement('div');
  el.className = `chat-message ${role}${error ? ' error' : ''}`;
  el.textContent = text;
  chatArea.appendChild(el);
  chatArea.scrollTop = chatArea.scrollHeight;
  return el;
}
async function sendChat(text) {
  if (!activeServer || !modelSelect.value || !text.trim()) return;
  const prompt = text.trim();
  history.push({ role: 'user', content: prompt });
  addMessage('user', prompt);
  promptInput.value = '';
  promptInput.style.height = 'auto';
  sendButton.disabled = true;
  promptInput.disabled = true;
  const waiting = addMessage('assistant', 'Thinking…');
  try {
    let result;
    try {
      result = await fetchServerJSON(activeServer, '/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: modelSelect.value, messages: history, stream: false }) });
    } catch (error) {
      if (![404, 405].includes(error.status)) throw error;
      result = await fetchServerJSON(activeServer, '/api/chat', { method: 'POST', body: JSON.stringify({ model: modelSelect.value, messages: history, stream: false }) });
    }
    const message = result.choices?.[0]?.message || result.message;
    const answer = message?.content || '(The model returned an empty response.)';
    history.push({ role: 'assistant', content: answer });
    waiting.textContent = answer;
  } catch (error) {
    waiting.textContent = error.message;
    waiting.classList.add('error');
    history.pop();
  } finally {
    sendButton.disabled = false;
    promptInput.disabled = false;
    promptInput.focus();
    chatArea.scrollTop = chatArea.scrollHeight;
  }
}

searchInput.addEventListener('input', render);
filterToggle.addEventListener('click', () => { freeOnly = !freeOnly; filterToggle.classList.toggle('is-off', !freeOnly); render(); });
document.getElementById('close-modal').addEventListener('click', closeModal);
modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
function closeModal() { modal.classList.remove('open'); modal.setAttribute('aria-hidden', 'true'); document.body.style.overflow = ''; }
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); searchInput.focus(); } });
document.getElementById('chat-form').addEventListener('submit', e => { e.preventDefault(); sendChat(promptInput.value); });
promptInput.addEventListener('input', () => { promptInput.style.height = 'auto'; promptInput.style.height = `${Math.min(promptInput.scrollHeight, 120)}px`; });
promptInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); document.getElementById('chat-form').requestSubmit(); } });
document.getElementById('copy-config').addEventListener('click', async e => {
  const yaml = `servers:\n  - id: my-ollama\n    name: My Ollama Server\n    url: https://ollama.example.com\n    region: US East\n    free: true\n    tags: [community, gpu]`;
  try { await navigator.clipboard.writeText(yaml); e.currentTarget.innerHTML = 'Copied! <span>✓</span>'; setTimeout(() => e.currentTarget.innerHTML = 'Copy example <span>▢</span>', 1600); }
  catch { showToast('Clipboard unavailable. Copy the example from servers.yaml instead.'); }
});

fetch('https://ollama.fourtexec.site/servers.yaml', { cache: 'no-store' }).then(async response => {
  if (!response.ok) throw new Error(`Could not load remote servers.yaml (${response.status})`);
  return response.text();
}).then(text => { servers = parseServersYaml(text); render(); }).catch(error => {
  grid.innerHTML = `<div class="empty-state"><strong>Couldn’t load remote servers.yaml</strong>${esc(error.message)}<br>Verify the remote file and its CORS settings, then reload.</div>`;
  resultsCount.textContent = 'Directory unavailable';
});
