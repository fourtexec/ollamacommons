# Ollama Commons

A free, self-hostable directory for Ollama-compatible endpoints. Browse configured servers, copy their OpenAI-compatible base URLs, and try listed models in an in-browser chat panel.

> This project is directory software, not a hosted GPU service. The included `.example.com` URLs are placeholders, not real free servers. Only list endpoints you operate or have permission to include.

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

The directory fetches its YAML directly from `https://ollama.fourtexec.site/servers.yaml`. Chat prompts go directly from the visitor's browser to the selected server, so the endpoint must allow CORS from the site's origin. Use the HTTP site for HTTP endpoints; browsers block HTTP endpoints from HTTPS pages. The local `servers.yaml` is an example/template; the live directory source is the remote YAML URL above.

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

Required fields: `id`, `name`, and `url`. Optional fields: `description`, `region`, `free`, `tags`, `models`, `featured`, and `example`. IDs should be unique. URLs must be HTTP or HTTPS. The in-browser chat menu uses the `models` list from YAML; add model names there for each server. The YAML reader supports block-list and inline arrays.

For browser chat, the target server must allow CORS from the site origin and expose either `/v1/chat/completions` or Ollama's `/api/chat` endpoint.

## Features

- Search/filter configured servers, tags, and listed models
- Copyable `/v1/` base URL for each server
- In-browser chat using a model name listed in the remote YAML
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

Only trust the maintainers of `https://ollama.fourtexec.site/servers.yaml`: its entries determine which endpoint receives a visitor's chat prompt. Prompts go directly from the browser to the selected server; that server's operator controls data handling. List only servers whose operators have agreed to be included.
