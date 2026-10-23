# Ollama Commons

A free, self-hostable directory for Ollama-compatible endpoints. Search listed models, expand server model lists, and copy OpenAI-compatible base URLs.

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

The directory fetches its YAML directly from `https://ollama.fourtexec.site/servers.yaml`; it does not contact the listed Ollama endpoints. The local `servers.yaml` is an example/template; the live directory source is the remote YAML URL above.

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

Required fields: `id`, `name`, and `url`. Optional fields: `description`, `region`, `free`, `tags`, `models`, `featured`, and `example`. IDs should be unique. URLs must be HTTP or HTTPS. The directory search and expandable model lists use the `models` list from YAML; add model names there for each server. The YAML reader supports block-list and inline arrays.

## Features

- Search/filter configured servers, tags, and listed models
- Copyable `/v1/` base URL for each server
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

Only trust the maintainers of `https://ollama.fourtexec.site/servers.yaml`: its entries determine which server and model information is displayed. List only endpoints you operate or have permission to include.
