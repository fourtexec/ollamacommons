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
let states = {};
let freeOnly = true;
let activeServer = null;
let activeModels = [];
let history = [];
let toastTimer;
const configuredAPIBase = (document.querySelector('meta[name="ollama-api-base"]')?.content || '').trim();
const isPublishedSite = location.hostname === 'ollama.fourtexec.site' || location.hostname.endsWith('.ollama.fourtexec.site') || location.hostname === 'fourtexec.github.io';
const API_BASE = (configuredAPIBase || (isPublishedSite ? 'http://localhost:3000' : '')).replace(/\/+$/, '');

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
function render() {
  const query = searchInput.value.trim().toLowerCase();
  const shown = servers.filter(s => {
    const state = states[s.id] || {};
    const modelText = (state.models || []).map(m => m.name).join(' ');
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
    const state = states[s.id] || {};
    const statusClass = state.status === 'online' ? 'online' : state.status === 'offline' ? 'offline' : '';
    const statusText = state.status === 'online' ? 'ONLINE' : state.status === 'offline' ? 'OFFLINE' : 'NOT CHECKED';
    const modelCount = state.models ? `${state.models.length} model${state.models.length === 1 ? '' : 's'}` : 'Check for models';
    const latency = state.latency != null ? ` · ${state.latency} ms` : '';
    const tags = (s.tags || []).slice(0, 3).map(t => `<span class="tag">${esc(t)}</span>`).join('');
    return `<article class="server-card">
      <div class="card-top"><span class="region-label"><span class="region-icon">⌖</span>${esc(s.region || 'Unknown region')}</span><span class="badges">${s.free ? '<i class="badge free">FREE</i>' : ''}${s.example ? '<i class="badge example">EXAMPLE</i>' : ''}</span></div>
      <div class="card-title"><h3>${esc(s.name)}</h3><span class="card-status ${statusClass}"><i class="status-led"></i>${statusText}${latency}</span></div>
      <p class="card-desc">${esc(s.description || 'Ollama-compatible server endpoint.')}</p>
      <div class="endpoint-line"><span>↗</span><code>${esc(openAIBaseUrl(s.url))}</code><button class="endpoint-copy" data-url="${esc(openAIBaseUrl(s.url))}" type="button">Copy</button></div>
      <div class="tag-list">${tags}</div>
      <div class="card-bottom"><span class="model-summary"><strong>${esc(modelCount)}</strong></span><div class="card-actions"><button class="card-button check-button" data-id="${esc(s.id)}">↻ Check</button><button class="card-button primary try-button" data-id="${esc(s.id)}">Try model <span>→</span></button></div></div>
    </article>`;
  }).join('');
  grid.querySelectorAll('.check-button').forEach(button => button.addEventListener('click', () => checkServer(button.dataset.id, button)));
  grid.querySelectorAll('.try-button').forEach(button => button.addEventListener('click', () => openPlayground(button.dataset.id)));
  grid.querySelectorAll('.endpoint-copy').forEach(button => button.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(button.dataset.url); showToast('OpenAI-compatible /v1/ URL copied'); }
    catch { showToast(`Copy this URL: ${button.dataset.url}`); }
  }));
}
async function getJSON(url, options) {
  const target = url.startsWith('/api/') ? `${API_BASE}${url}` : url;
  let response;
  try { response = await fetch(target, options); }
  catch (error) {
    if (API_BASE.includes('localhost') || API_BASE.includes('127.0.0.1')) {
      throw new Error('Could not reach the local checker. Run `npm start` on this computer and allow the page to access your local network.');
    }
    throw error;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (data.error) throw new Error(data.error);
    if ([404, 405].includes(response.status) && url.startsWith('/api/')) {
      throw new Error(`HTTP ${response.status}: this host has no Ollama API backend. GitHub Pages is static-only; deploy server.js and set the ollama-api-base meta tag to that API URL.`);
    }
    throw new Error(`Request failed (${response.status})`);
  }
  return data;
}
async function checkServer(id, button) {
  const original = button?.innerHTML;
  if (button) { button.disabled = true; button.textContent = 'Checking…'; }
  states[id] = { ...(states[id] || {}), status: 'checking' };
  render();
  try {
    const data = await getJSON(`/api/servers/${encodeURIComponent(id)}/check`);
    states[id] = { status: 'online', latency: data.latency, models: data.models || [], version: data.version };
    if (activeServer?.id === id) setActiveModels(data.models || [], data.version, data.latency);
    showToast(`Server responded in ${data.latency} ms · ${data.models?.length || 0} models found`);
  } catch (error) {
    states[id] = { ...(states[id] || {}), status: 'offline', error: error.message };
    if (activeServer?.id === id) {
      document.getElementById('play-server-meta').textContent = error.message;
      modelSelect.disabled = true;
      promptInput.disabled = true;
      sendButton.disabled = true;
    }
    showToast(error.message);
  }
  render();
}
function openPlayground(id) {
  activeServer = servers.find(s => s.id === id);
  if (!activeServer) return;
  history = [];
  activeModels = [];
  document.getElementById('play-server-name').textContent = activeServer.name;
  document.getElementById('play-server-meta').textContent = activeServer.region || activeServer.url;
  modelSelect.innerHTML = '<option>Checking available models…</option>';
  modelSelect.disabled = true;
  promptInput.disabled = true;
  sendButton.disabled = true;
  resetChat();
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  checkServer(id);
}
function setActiveModels(models, version, latency) {
  activeModels = models;
  const meta = `${version ? `Ollama ${version} · ` : ''}${latency} ms · ${models.length} model${models.length === 1 ? '' : 's'}`;
  document.getElementById('play-server-meta').textContent = meta;
  if (!models.length) {
    modelSelect.innerHTML = '<option>No models installed on this server</option>';
    modelSelect.disabled = true;
    promptInput.disabled = true;
    sendButton.disabled = true;
    return;
  }
  modelSelect.innerHTML = models.map(m => `<option value="${esc(m.name)}">${esc(m.name)}${m.size ? ` · ${formatSize(m.size)}` : ''}</option>`).join('');
  modelSelect.disabled = false;
  promptInput.disabled = false;
  sendButton.disabled = false;
  promptInput.focus();
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
    const result = await getJSON(`/api/servers/${encodeURIComponent(activeServer.id)}/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelSelect.value, messages: history })
    });
    const answer = result.message?.content || '(The model returned an empty response.)';
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
document.getElementById('play-check').addEventListener('click', () => activeServer && checkServer(activeServer.id));
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
  grid.innerHTML = `<div class="empty-state"><strong>Couldn’t load remote servers.yaml</strong>${esc(error.message)}<br>Check the remote file and its CORS settings, then reload.</div>`;
  resultsCount.textContent = 'Directory unavailable';
});
