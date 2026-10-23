# Ollama Commons

A free, self-hostable directory for Ollama-compatible endpoints. Browse configured servers, test reachability and model availability, and try a model in an in-browser chat panel.

> This project is directory and testing software, not a hosted GPU service. The included public-looking `.example.com` URLs are placeholders, not real free servers. Only list endpoints you operate or have permission to use.

## Run it

Requires Node.js 18 or newer. No npm dependencies are required.

```bash
npm start
# open http://localhost:3000
```

## Build and host on GitHub Pages

```bash
npm run build
```

This creates a self-contained `index.html` for GitHub Pages and `ollama-commons.html` as a separate copy. `CNAME` is set to `ollama.fourtexec.site`; configure that custom domain in the repository's Pages settings and DNS. Publish the generated root `index.html`, `CNAME`, and `.nojekyll` on the Pages branch (`ghpages` for this repository).

The directory itself loads from `https://ollama.fourtexec.site/servers.yaml`. On either `ollama.fourtexec.site` or `fourtexec.github.io`, the page sends checks and chat to the visitor's local Node helper at `http://localhost:3000`. Each visitor must download/clone this project and run `npm start`, then allow the browser's local-network access prompt. The helper binds to loopback only by default and allows requests from both Pages origins. Visitors can alternatively open `http://localhost:3000` for a same-origin local version. GitHub Pages alone cannot run the checker backend; without the helper, browsing works but check/chat show a setup message.

The browser fetches the directory YAML directly from `https://ollama.fourtexec.site/servers.yaml` (not from `/api/servers`), with caching disabled. That host must allow cross-origin reads (CORS). The backend also fetches the same remote YAML for live checks and chat routing. The local `servers.yaml` is an example/template; publish your edited YAML at that URL for it to become the live directory source.

## Configure an endpoint

```yaml
servers:
  - id: my-ollama
    name: My Ollama Server
    url: https://ollama.example.com
    description: A short description of the models or hardware.
    region: US East
    free: true
    tags: [community, gpu]
    featured: true
    example: false
```

Required fields: `id`, `name`, and `url`. Optional fields: `description`, `region`, `free`, `tags`, `featured`, and `example`. IDs should be unique. URLs must be HTTP or HTTPS. The included minimal YAML reader supports flat server records, scalar values, booleans, quoted strings, and inline arrays.

The target server must expose Ollama's API, generally at port `11434`, and have the model(s) installed. This app's backend contacts the configured URL, so the endpoint must be reachable from the machine running this directory. For a server on another machine, bind Ollama to a reachable interface and configure appropriate network access; do not expose an unauthenticated endpoint to the public internet without protection.

## Features

- Search/filter configured servers and tags
- Tests OpenAI-compatible `/v1/models`; falls back to Ollama `/api/tags` if needed
- Copyable `/v1/` base URL for each server
- In-browser playground tries `/v1/chat/completions`, then falls back to `/api/chat`
- Same-origin backend proxy to avoid browser CORS issues
- No accounts, database, API key, or third-party npm dependency

## Hourly opt-in registry updater

`update_servers.py` imports only entries from HTTPS YAML feeds explicitly listed in `optin_sources.yaml`, and only when an entry contains `opt_in: true`. It does not use Shodan, scan IP ranges, or probe discovered endpoints. Add feeds only when their operators have agreed to directory inclusion.

```bash
python -m pip install -r requirements.txt
# Use a fine-grained GitHub token with Contents: read/write on fourtexec/ollamacommons.
export GITHUB_TOKEN="<your-token>"
python update_servers.py --once       # one pass
python update_servers.py              # immediate pass, then once per hour
python update_servers.py --dry-run    # preview feeds; no writes or commits
```

The script merges opted-in entries into local `servers.yaml`, skips duplicate IDs and normalized URLs, and commits to `fourtexec/ollamacommons` only when the YAML changes. The script reads the repository's default branch from GitHub automatically; set `GITHUB_BRANCH` only if you want to override it. The token is read from the environment or hidden prompt; never put it in the script or commit it. The local updater needs Python 3.10+ and `PyYAML`.

Opt-in feed entries need `id`, `name`, `url`, and the explicit boolean `opt_in: true`. For example:

```yaml
servers:
  - id: community-gpu-1
    name: Community GPU Server
    url: https://ollama.example.org
    region: US East
    free: true
    opt_in: true
    tags: [community, gpu]
```

## Security notes

Only trust the maintainers of `https://ollama.fourtexec.site/servers.yaml`: its entries determine which URLs this backend contacts and proxies chat requests to. Secure that YAML source and the directory backend; add authentication, rate limits, TLS, and network restrictions before exposing this service publicly. Prompts are sent to the selected server, whose operator controls its data handling.
