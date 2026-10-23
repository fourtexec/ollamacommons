const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const SERVERS_YAML_URL = 'https://ollama.fourtexec.site/servers.yaml';
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const CORS_ORIGINS = (process.env.CORS_ORIGINS || 'https://ollama.fourtexec.site,https://fourtexec.github.io').split(',').map(origin => origin.trim()).filter(Boolean);
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8' };

// A deliberately small YAML reader for the flat `servers:` schema in servers.yaml.
// Supports scalar values, quoted strings, booleans and inline arrays.
function parseYaml(text) {
  const servers = [];
  let current = null;
  let activeArray = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line === 'servers:') continue;
    if (/^-\s+id\s*:/.test(line)) {
      if (current) servers.push(current);
      current = {};
      activeArray = null;
      assign(current, line.slice(2).trim());
      continue;
    }
    if (!current) continue;
    if (line.startsWith('- ') && activeArray) {
      current[activeArray].push(unquote(line.slice(2)));
      continue;
    }
    if (line.includes(':')) {
      const colon = line.indexOf(':');
      const key = line.slice(0, colon).trim();
      const rawValue = line.slice(colon + 1).trim();
      if (!rawValue) {
        current[key] = [];
        activeArray = key;
      } else {
        assign(current, line);
        activeArray = null;
      }
    }
  }
  if (current) servers.push(current);
  return servers;
}
function unquote(value) {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}
function assign(target, line) {
  const colon = line.indexOf(':');
  if (colon < 0) return;
  const key = line.slice(0, colon).trim();
  let value = line.slice(colon + 1).trim();
  if (value.startsWith('[') && value.endsWith(']')) {
    value = value.slice(1, -1).split(',').map(x => unquote(x)).filter(Boolean);
  } else if (value === 'true') value = true;
  else if (value === 'false') value = false;
  else value = unquote(value);
  target[key] = value;
}
async function getServers() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  let yamlText;
  try {
    const response = await fetch(SERVERS_YAML_URL, {
      signal: controller.signal,
      headers: { Accept: 'text/yaml, text/plain, */*' }
    });
    if (!response.ok) throw new Error(`Could not fetch servers.yaml: HTTP ${response.status}`);
    yamlText = await response.text();
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Timed out fetching the remote servers.yaml file.');
    throw new Error(`Could not fetch ${SERVERS_YAML_URL}: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
  const servers = parseYaml(yamlText);
  const ids = new Set();
  for (const server of servers) {
    if (!server.id || !server.name || !server.url) throw new Error('Every remote server entry needs an id, name and url.');
    if (ids.has(server.id)) throw new Error(`Duplicate server id in remote servers.yaml: ${server.id}`);
    ids.add(server.id);
    const parsed = new URL(server.url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`Unsupported URL protocol for ${server.id}`);
    server.url = server.url.replace(/\/$/, '');
    server.tags = Array.isArray(server.tags) ? server.tags : [];
    server.free = server.free !== false;
    server.featured = server.featured === true;
    server.example = server.example === true;
  }
  return servers;
}
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin || !CORS_ORIGINS.length) return;
  const allowedOrigin = CORS_ORIGINS.includes('*') ? '*' : CORS_ORIGINS.includes(origin) ? origin : null;
  if (!allowedOrigin) return;
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
  if (req.headers['access-control-request-private-network'] === 'true') {
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
}
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > limit) { reject(new Error('Request body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}
function endpointUrl(server, endpoint) {
  const base = server.url.replace(/\/+$/, '');
  const route = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  if (base.toLowerCase().endsWith('/v1') && route.toLowerCase().startsWith('/v1/')) return `${base}${route.slice(3)}`;
  return `${base}${route}`;
}
async function ollamaFetch(server, endpoint, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(endpointUrl(server, endpoint), { ...options, signal: controller.signal, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 1000) }; }
    if (!response.ok) {
      const error = new Error(data.error || `Ollama returned HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return data;
  } finally { clearTimeout(timer); }
}
async function getModelList(server) {
  try {
    const data = await ollamaFetch(server, '/v1/models');
    if (Array.isArray(data.data)) {
      return { models: data.data.map(model => ({ name: model.id, owned_by: model.owned_by })), apiMode: 'openai' };
    }
  } catch (error) {
    if (![404, 405].includes(error.status)) throw error;
  }
  const data = await ollamaFetch(server, '/api/tags');
  return { models: (data.models || []).map(model => ({ ...model, name: model.name })), apiMode: 'ollama' };
}
function sendFile(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep) && file !== path.join(PUBLIC, 'index.html')) return json(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, content) => {
    if (err) return json(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(content);
  });
}

const app = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  applyCors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }
  try {
    if (requestUrl.pathname === '/api/servers' && req.method === 'GET') {
      const servers = (await getServers()).map(({ id, name, url, description = '', region = 'Unknown', free, tags, featured, example }) => ({ id, name, url, description, region, free, tags, featured, example }));
      return json(res, 200, { servers });
    }
    const match = requestUrl.pathname.match(/^\/api\/servers\/([^/]+)\/(check|models|chat)$/);
    if (match) {
      const [, id, action] = match;
      const server = (await getServers()).find(item => item.id === decodeURIComponent(id));
      if (!server) return json(res, 404, { error: 'Server not found in servers.yaml' });
      if (action === 'check' && req.method === 'GET') {
        const started = Date.now();
        const { models, apiMode } = await getModelList(server);
        return json(res, 200, { online: true, latency: Date.now() - started, models, version: null, apiMode });
      }
      if (action === 'models' && req.method === 'GET') {
        const { models, apiMode } = await getModelList(server);
        return json(res, 200, { models, apiMode });
      }
      if (action === 'chat' && req.method === 'POST') {
        const body = await readBody(req);
        if (typeof body.model !== 'string' || !body.model.trim()) return json(res, 400, { error: 'Choose a model first.' });
        if (!Array.isArray(body.messages) || !body.messages.length) return json(res, 400, { error: 'Add a message first.' });
        let data;
        try {
          data = await ollamaFetch(server, '/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: body.model, messages: body.messages, stream: false }) });
        } catch (error) {
          if (![404, 405].includes(error.status)) throw error;
          data = await ollamaFetch(server, '/api/chat', { method: 'POST', body: JSON.stringify({ model: body.model, messages: body.messages, stream: false }) });
        }
        const message = data.choices?.[0]?.message || data.message || null;
        return json(res, 200, { message, usage: data.usage || null });
      }
      return json(res, 405, { error: 'Method not allowed' });
    }
    if (requestUrl.pathname.startsWith('/api/')) return json(res, 404, { error: 'API route not found' });
    return sendFile(res, requestUrl.pathname);
  } catch (error) {
    const timedOut = error.name === 'AbortError';
    return json(res, 502, { error: timedOut ? 'Connection timed out. Check that the endpoint is reachable.' : error.message || 'Could not reach the Ollama server.' });
  }
});
app.listen(PORT, HOST, () => console.log(`Ollama Free Directory running at http://${HOST}:${PORT}`));
