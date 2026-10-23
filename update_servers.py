#!/usr/bin/env python3
"""Merge explicitly opt-in Ollama server feeds into servers.yaml and commit to GitHub.

This script does not scan Shodan, probe arbitrary IP addresses, or query discovered
servers. It only imports entries published in feed URLs listed in optin_sources.yaml
when those entries include `opt_in: true`.
"""
from __future__ import annotations

import argparse
import base64
import getpass
import ipaddress
import json
import os
import signal
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit, urlunsplit
from urllib.request import Request, urlopen

import yaml

ROOT = Path(__file__).resolve().parent
LOCAL_REGISTRY = ROOT / "servers.yaml"
SOURCE_CONFIG = ROOT / "optin_sources.yaml"
OWNER = os.getenv("GITHUB_OWNER", "fourtexec")
REPO = os.getenv("GITHUB_REPO", "ollamacommons")
BRANCH = os.getenv("GITHUB_BRANCH")
REGISTRY_PATH = os.getenv("GITHUB_REGISTRY_PATH", "servers.yaml")
POLL_SECONDS = 60 * 60
MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024
USER_AGENT = "OllamaCommons-OptInRegistryUpdater/1.0"
STOP = False


def request_bytes(url: str, *, token: str | None = None, method: str = "GET", data: bytes | None = None) -> bytes:
    headers = {"User-Agent": USER_AGENT, "Accept": "application/yaml, text/yaml, text/plain, application/json, */*"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
        headers["X-GitHub-Api-Version"] = "2022-11-28"
    if data is not None:
        headers["Content-Type"] = "application/json; charset=utf-8"
    req = Request(url, data=data, headers=headers, method=method)
    try:
        with urlopen(req, timeout=20) as response:
            body = response.read(MAX_DOWNLOAD_BYTES + 1)
            if len(body) > MAX_DOWNLOAD_BYTES:
                raise RuntimeError(f"Response from {url} is larger than {MAX_DOWNLOAD_BYTES} bytes")
            return body
    except HTTPError as exc:
        detail = exc.read(1000).decode("utf-8", "replace")
        raise RuntimeError(f"HTTP {exc.code} from {url}: {detail}") from exc
    except URLError as exc:
        raise RuntimeError(f"Could not reach {url}: {exc.reason}") from exc


def request_github_contents(url: str, token: str, method: str = "GET", payload: dict[str, Any] | None = None) -> tuple[int, bytes]:
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    if data is not None:
        headers["Content-Type"] = "application/json; charset=utf-8"
    req = Request(url, data=data, headers=headers, method=method)
    try:
        with urlopen(req, timeout=30) as response:
            return response.status, response.read(MAX_DOWNLOAD_BYTES + 1)
    except HTTPError as exc:
        if exc.code == 404:
            return 404, b""
        detail = exc.read(1500).decode("utf-8", "replace")
        raise RuntimeError(f"GitHub API HTTP {exc.code}: {detail}") from exc
    except URLError as exc:
        raise RuntimeError(f"GitHub API request failed: {exc.reason}") from exc


def load_yaml_text(text: str, label: str) -> list[dict[str, Any]]:
    try:
        document = yaml.safe_load(text) or {}
    except yaml.YAMLError as exc:
        raise RuntimeError(f"Invalid YAML in {label}: {exc}") from exc
    if not isinstance(document, dict):
        raise RuntimeError(f"{label} must contain a top-level 'servers:' mapping")
    entries = document.get("servers", [])
    if entries is None:
        return []
    if not isinstance(entries, list):
        raise RuntimeError(f"{label}: 'servers' must be a list")
    return entries


def read_local_registry() -> list[dict[str, Any]]:
    if not LOCAL_REGISTRY.exists():
        return []
    return load_yaml_text(LOCAL_REGISTRY.read_text(encoding="utf-8"), str(LOCAL_REGISTRY))


def load_source_urls() -> list[dict[str, str]]:
    if not SOURCE_CONFIG.exists():
        return []
    try:
        config = yaml.safe_load(SOURCE_CONFIG.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as exc:
        raise RuntimeError(f"Invalid YAML in {SOURCE_CONFIG}: {exc}") from exc
    sources = config.get("sources", []) if isinstance(config, dict) else None
    if not isinstance(sources, list):
        raise RuntimeError("optin_sources.yaml must define 'sources' as a list")
    result = []
    for item in sources:
        if not isinstance(item, dict) or not item.get("url"):
            print(f"[skip] Invalid source entry in {SOURCE_CONFIG}")
            continue
        url = str(item["url"]).strip()
        if urlsplit(url).scheme != "https":
            print(f"[skip] Feed must use HTTPS: {url}")
            continue
        result.append({"name": str(item.get("name") or url), "url": url})
    return result


def canonical_url(value: str) -> str:
    parsed = urlsplit(str(value).strip())
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
        raise ValueError("url must be an absolute HTTP(S) URL")
    if parsed.username or parsed.password:
        raise ValueError("URLs containing credentials are not accepted")
    host = parsed.hostname.lower().rstrip(".")
    port = parsed.port
    if port == (443 if parsed.scheme.lower() == "https" else 80):
        port = None
    netloc = host if port is None else f"{host}:{port}"
    path = parsed.path.rstrip("/")
    return urlunsplit((parsed.scheme.lower(), netloc, path, parsed.query, ""))


def is_public_endpoint(value: str) -> bool:
    """Reject obvious local/private targets for newly discovered feed entries."""
    host = urlsplit(value).hostname or ""
    host = host.lower().rstrip(".")
    if host == "localhost" or host.endswith((".localhost", ".local", ".internal")):
        return False
    try:
        return ipaddress.ip_address(host).is_global
    except ValueError:
        # Domain names are allowed; feeds themselves must be explicitly trusted.
        return True


def clean_entry(raw: Any, *, require_opt_in: bool) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    if require_opt_in and raw.get("opt_in") is not True:
        return None
    identifier = str(raw.get("id", "")).strip()
    name = str(raw.get("name", "")).strip()
    endpoint = str(raw.get("url", "")).strip()
    if not identifier or not name or not endpoint:
        return None
    try:
        normalized_url = canonical_url(endpoint)
    except ValueError as exc:
        print(f"[skip] {identifier}: {exc}")
        return None
    if require_opt_in and not is_public_endpoint(endpoint):
        print(f"[skip] {identifier}: opted-in feed entry points to a local/private host")
        return None
    entry: dict[str, Any] = {
        "id": identifier,
        "name": name,
        "url": endpoint.rstrip("/"),
    }
    for key in ("description", "region"):
        if raw.get(key) not in (None, ""):
            entry[key] = str(raw[key]).strip()
    for key in ("free", "featured", "example", "opt_in"):
        if key in raw:
            entry[key] = raw[key] is True
    tags = raw.get("tags", [])
    if isinstance(tags, list):
        entry["tags"] = [str(tag).strip() for tag in tags if str(tag).strip()]
    entry["_canonical_url"] = normalized_url
    return entry


def discover_opted_in() -> list[dict[str, Any]]:
    discovered = []
    for source in load_source_urls():
        try:
            content = request_bytes(source["url"]).decode("utf-8")
            rows = load_yaml_text(content, source["url"])
            count = 0
            for row in rows:
                entry = clean_entry(row, require_opt_in=True)
                if entry:
                    discovered.append(entry)
                    count += 1
            print(f"[feed] {source['name']}: {count} opted-in server(s)")
        except Exception as exc:
            print(f"[warn] Feed {source['url']}: {exc}")
    return discovered


def merge_entries(*groups: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    seen_urls: set[str] = set()
    for group in groups:
        for raw in group:
            entry = clean_entry(raw, require_opt_in=False)
            if not entry:
                continue
            identifier = entry["id"].casefold()
            normalized_url = entry.pop("_canonical_url")
            if identifier in seen_ids or normalized_url in seen_urls:
                continue
            seen_ids.add(identifier)
            seen_urls.add(normalized_url)
            merged.append(entry)
    return merged


def dump_registry(entries: list[dict[str, Any]]) -> str:
    """Write the flat YAML format used by the directory's tiny YAML parser."""
    lines = ["# Ollama server directory. New automated additions must be opt-in.", "servers:"]
    for entry in entries:
        lines.append(f"  - id: {json.dumps(entry['id'], ensure_ascii=False)}")
        for key in ("name", "url", "description", "region"):
            if key in entry:
                lines.append(f"    {key}: {json.dumps(entry[key], ensure_ascii=False)}")
        for key in ("free", "featured", "example", "opt_in"):
            if key in entry:
                lines.append(f"    {key}: {'true' if entry[key] else 'false'}")
        if "tags" in entry:
            tags = ", ".join(json.dumps(tag, ensure_ascii=False) for tag in entry["tags"])
            lines.append(f"    tags: [{tags}]")
    return "\n".join(lines) + "\n"


def resolve_branch(token: str) -> str:
    global BRANCH
    if BRANCH:
        return BRANCH
    url = f"https://api.github.com/repos/{OWNER}/{REPO}"
    status, body = request_github_contents(url, token)
    if status != 200:
        raise RuntimeError(f"Could not determine the default branch for {OWNER}/{REPO}")
    metadata = json.loads(body.decode("utf-8"))
    branch = metadata.get("default_branch")
    if not branch:
        raise RuntimeError(f"GitHub did not report a default branch for {OWNER}/{REPO}")
    BRANCH = str(branch)
    print(f"[info] Using repository default branch: {BRANCH}")
    return BRANCH


def github_file_url() -> str:
    encoded_path = quote(REGISTRY_PATH, safe="/")
    branch = BRANCH or "main"
    return f"https://api.github.com/repos/{OWNER}/{REPO}/contents/{encoded_path}?ref={quote(branch)}"


def get_github_registry(token: str) -> tuple[list[dict[str, Any]], str | None]:
    status, body = request_github_contents(github_file_url(), token)
    if status == 404:
        return [], None
    data = json.loads(body.decode("utf-8"))
    decoded = base64.b64decode(data["content"]).decode("utf-8")
    return load_yaml_text(decoded, f"GitHub {OWNER}/{REPO}:{REGISTRY_PATH}"), data["sha"]


def commit_registry(token: str, content: str, sha: str | None) -> None:
    url = f"https://api.github.com/repos/{OWNER}/{REPO}/contents/{quote(REGISTRY_PATH, safe='/')}"
    payload: dict[str, Any] = {
        "message": f"Update opt-in Ollama servers ({datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')})",
        "content": base64.b64encode(content.encode("utf-8")).decode("ascii"),
        "branch": BRANCH or "main",
    }
    if sha:
        payload["sha"] = sha
    status, _ = request_github_contents(url, token, method="PUT", payload=payload)
    if status not in (200, 201):
        raise RuntimeError(f"Unexpected GitHub API status: {status}")


def run_cycle(token: str | None, dry_run: bool = False) -> None:
    remote_entries: list[dict[str, Any]] = []
    sha = None
    github_read_ok = False
    if token:
        try:
            resolve_branch(token)
            remote_entries, sha = get_github_registry(token)
            github_read_ok = True
        except Exception as exc:
            print(f"[warn] Could not read GitHub registry; using local YAML as base: {exc}")
    local_entries = read_local_registry()
    discovered = discover_opted_in()
    merged = merge_entries(remote_entries, local_entries, discovered)
    new_count = max(0, len(merged) - len(merge_entries(remote_entries, local_entries)))
    content = dump_registry(merged)
    print(f"[info] {len(merged)} unique server(s); {new_count} new opted-in server(s) this cycle")
    if dry_run:
        print("[dry-run] No local file or GitHub commit written.")
        return

    LOCAL_REGISTRY.write_text(content, encoding="utf-8")
    if not token:
        print("[warn] No GitHub token; updated local servers.yaml only.")
        return

    if not github_read_ok:
        print("[warn] Skipping GitHub commit because the remote registry could not be read safely.")
        return
    if sha:
        remote_content = dump_registry(merge_entries(remote_entries))
        if content == remote_content:
            print("[info] GitHub registry is already up to date; no commit needed.")
            return
    try:
        commit_registry(token, content, sha)
        print(f"[commit] Pushed {REGISTRY_PATH} to {OWNER}/{REPO} ({BRANCH})")
    except Exception as exc:
        print(f"[error] GitHub commit failed: {exc}")


def handle_signal(_signum: int, _frame: Any) -> None:
    global STOP
    STOP = True
    print("\n[info] Stopping after the current cycle…")


def main() -> int:
    parser = argparse.ArgumentParser(description="Import only explicitly opted-in Ollama server feeds and commit updates hourly.")
    parser.add_argument("--once", action="store_true", help="run one update cycle and exit")
    parser.add_argument("--dry-run", action="store_true", help="preview feed discovery without writing files or committing")
    parser.add_argument("--interval", type=int, default=POLL_SECONDS, help="poll interval in seconds (default: 3600)")
    args = parser.parse_args()
    if args.interval < 60:
        parser.error("--interval must be at least 60 seconds")

    token = os.getenv("GITHUB_TOKEN")
    if not token and not args.dry_run:
        token = getpass.getpass("GitHub token (hidden input; needs Contents read/write on the repo): ").strip()
    if not token and not args.dry_run:
        print("[error] A GitHub token is required for committing.", file=sys.stderr)
        return 2

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)
    while not STOP:
        print(f"\n[{datetime.now(timezone.utc).isoformat(timespec='seconds')}] Starting registry update")
        try:
            run_cycle(token, dry_run=args.dry_run)
        except Exception as exc:
            print(f"[error] Update cycle failed: {exc}")
        if args.once or STOP:
            break
        print(f"[info] Sleeping for {args.interval} seconds (one hour by default). Press Ctrl+C to stop.")
        deadline = time.monotonic() + args.interval
        while not STOP and time.monotonic() < deadline:
            time.sleep(min(1, max(0, deadline - time.monotonic())))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
