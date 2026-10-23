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

The directory fetches its YAML directly from `https://ollama.fourtexec.site/servers.yaml`. Checks and chat are also sent directly from each visitor's browser to the selected server; no local helper or backend is used by the Pages site. For browser security, every listed endpoint must use HTTPS and allow CORS from `https://ollama.fourtexec.site` (and `https://fourtexec.github.io` if using the project URL). HTTP IP endpoints are blocked as mixed content on an HTTPS GitHub Pages site. The current HTTP-only entries therefore need HTTPS URLs and CORS enabled before browser-only checking can work. The local `servers.yaml` is an example/template; the live directory source is the remote YAML URL above.

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

For GitHub Pages browser-only checks, target servers must expose Ollama's API over HTTPS, have the model(s) installed, and allow CORS from the Pages origin. Plain HTTP endpoints work in command-line clients but are blocked as mixed content from this HTTPS site.

## Features

- Search/filter configured servers and tags
- Browser-direct check: tries `/v1/models`, falls back to `/api/tags`
- Copyable `/v1/` base URL for each server
- Browser-direct chat: tries `/v1/chat/completions`, falls back to `/api/chat`
- No API backend or local software needed for browser-compatible HTTPS+CORS endpoints
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

Only trust the maintainers of `https://ollama.fourtexec.site/servers.yaml`: its entries determine which endpoints the browser will contact when a visitor checks or chats. Prompts go directly from the browser to the selected server; that server's operator controls data handling. List only servers whose operators have agreed to be included.
