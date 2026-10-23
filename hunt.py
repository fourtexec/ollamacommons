#!/usr/bin/env python3
"""
github_ollama_hunter.py

Источник серверов — Shodan (как в оригинале):
  https://www.shodan.io/search/facet?query=port:11434 product:"Ollama" -tag:honeypot&facet=ip

- Собирает IP с Shodan.
- Для каждого уникального публичного IP проверяет http://IP:11434/api/tags.
- Отсекает приватные/локальные адреса ДО запроса.
- Требует настоящий Ollama JSON (Content-Type + models[].digest/size).
- Добавляет новые серверы в servers.yaml (без дублей по url).
- Раз в час коммитит и пушит изменения в git.

Режимы:
  --once        один проход -> commit -> push -> exit
  (без --once)  цикл: проход каждые --interval сек, commit не чаще раза в час
"""

import argparse
import os
import re
import sys
import json
import time
import signal
import platform
import ipaddress
import subprocess
import urllib.parse
from datetime import datetime
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests
from requests.exceptions import RequestException
import yaml

# ---------- Конфиг ----------
OLLAMA_PORT = 11434
SERVERS_FILE = Path("servers.yaml")
STATE_FILE = Path(".github_hunter_state.json")
COMMIT_INTERVAL = 3600          # 1 час (loop-режим)
CHECK_INTERVAL = 1800           # 30 минут между проходами (loop-режим)
MAX_WORKERS = 20
SHODAN_FACET_URL = "https://www.shodan.io/search/facet"
SHODAN_QUERY = 'port:11434 product:"Ollama" -tag:honeypot'

# Git: что коммитим и куда пушим
GIT_REMOTE = os.environ.get("GIT_REMOTE", "origin")
GIT_BRANCH = os.environ.get("GIT_BRANCH", "")  # если пусто — возьмём текущую


# ---------- Уведомления ----------
def _ps_escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ")


def _which(cmd: str) -> bool:
    from shutil import which
    return which(cmd) is not None


def send_notification(title: str, message: str):
    system = platform.system()
    try:
        if system == "Linux":
            for cmd in (
                ["notify-send", "-u", "normal", "-a", "OllamaHunter", title, message],
                ["kdialog", "--title", title, "--passivepopup", message, "10"],
                ["zenity", "--info", "--title", title, "--text", message],
            ):
                if _which(cmd[0]):
                    subprocess.run(cmd, check=False, timeout=10)
                    return
        elif system == "Windows":
            ps = f'''
            [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
            $t = @"
            <Toast><Visual><Binding template="ToastGeneric">
              <Text>{_ps_escape(title)}</Text><Text>{_ps_escape(message)}</Text>
            </Binding></Visual></Toast>
            "@
            $x = New-Object Windows.Data.Xml.Dom.XmlDocument
            $x.LoadXml($t)
            $n = [Windows.UI.Notifications.ToastNotification]::new($x)
            [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("OllamaHunter").Show($n)
            '''
            try:
                subprocess.run(
                    ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps],
                    check=True, timeout=15,
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
                return
            except Exception:
                subprocess.run(["msg", "*", f"{title}\n\n{message}"], check=False, timeout=10,
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                return
        elif system == "Darwin":
            script = f'display notification "{_ps_escape(message)}" with title "{_ps_escape(title)}"'
            subprocess.run(["osascript", "-e", script], check=False, timeout=10)
            return
    except Exception as e:
        print(f"[!] notify failed: {e}")
    print(f"[notify] {title}: {message}")


# ---------- Shodan ----------
def get_shodan_ips():
    encoded_query = urllib.parse.quote_plus(SHODAN_QUERY)
    try:
        r = requests.get(
            f"{SHODAN_FACET_URL}?query={encoded_query}&facet=ip",
            timeout=15,
            headers={"User-Agent": "Mozilla/5.0"},
        )
        r.raise_for_status()
        ip_pattern = r"\b(?:\d{1,3}\.){3}\d{1,3}\b"
        return list(set(re.findall(ip_pattern, r.text)))
    except RequestException as e:
        print(f"[!] Ошибка при получении IP из Shodan: {e}")
        return []


# ---------- Проверки ----------
def is_public_ip(ip: str) -> bool:
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return False
    if (a.is_private or a.is_loopback or a.is_link_local
            or a.is_multicast or a.is_reserved or a.is_unspecified):
        return False
    return True


def check_ollama_server(ip: str):
    base_url = f"http://{ip}:{OLLAMA_PORT}"
    tags_url = f"{base_url}/api/tags"
    try:
        r = requests.get(tags_url, timeout=6, allow_redirects=False)
        if r.status_code != 200:
            return None
        ctype = r.headers.get("Content-Type", "").lower()
        if "application/json" not in ctype and "text/json" not in ctype:
            return None
        data = r.json()
        if not isinstance(data, dict):
            return None
        models = data.get("models")
        if not isinstance(models, list) or not models:
            return None
        names = []
        for m in models:
            if not isinstance(m, dict):
                continue
            name = m.get("name") or m.get("model")
            if not isinstance(name, str) or not name:
                continue
            if "digest" not in m and "size" not in m:
                continue
            names.append(name)
        if not names:
            return None
        return {
            "url": base_url,
            "ip": ip,
            "model_count": len(names),
            "models": names,
            "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }
    except Exception:
        return None


# ---------- servers.yaml ----------
def _norm_url(url: str) -> str:
    return url.rstrip("/").lower()


def load_servers() -> dict:
    if not SERVERS_FILE.exists():
        return {"servers": []}
    with SERVERS_FILE.open("r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    data.setdefault("servers", [])
    return data


def save_servers(data: dict):
    with SERVERS_FILE.open("w", encoding="utf-8") as f:
        yaml.safe_dump(data, f, sort_keys=False, allow_unicode=True, default_flow_style=False)


def server_exists(data: dict, url: str) -> bool:
    n = _norm_url(url)
    for s in data["servers"]:
        if _norm_url(s.get("url", "")) == n:
            return True
    return False


def make_server_entry(url: str, info: dict) -> dict:
    host = urllib.parse.urlparse(url).netloc.replace(":", "_")
    sid = re.sub(r"[^a-z0-9\-_]", "-", host.lower())
    return {
        "id": sid,
        "name": f"Discovered · {host}",
        "url": url,
        "description": f"Auto-discovered Ollama endpoint ({info['model_count']} models). "
                       f"Detected {info['timestamp']}.",
        "region": "Auto",
        "free": True,
        "tags": ["auto-discovered", "community"],
        "featured": False,
        "example": False,
        "models": info["models"][:20],
    }


# ---------- Git (реальный push) ----------
def _run(cmd, timeout=60, check=False):
    return subprocess.run(cmd, timeout=timeout, capture_output=True, text=True, check=check)


def _git_has_remote(remote: str) -> bool:
    r = _run(["git", "remote"])
    if r.returncode != 0:
        return False
    return remote in r.stdout.split()


def _git_current_branch() -> str:
    r = _run(["git", "rev-parse", "--abbrev-ref", "HEAD"])
    if r.returncode != 0:
        return ""
    return r.stdout.strip()


def _git_has_staged_changes() -> bool:
    r = _run(["git", "diff", "--cached", "--quiet"])
    return r.returncode != 0  # 1 = есть изменения


def _git_has_upstream(remote: str, branch: str) -> bool:
    r = _run(["git", "rev-parse", "--abbrev-ref", f"{branch}@{{upstream}}"])
    return r.returncode == 0 and r.stdout.strip().startswith(f"{remote}/")


def git_commit_and_push(message: str) -> bool:
    """
    Возвращает True, если коммит+push выполнены успешно (или пушить было нечего
    и рабочее дерево чистое). False — если что-то сломалось.
    """
    # 0) Проверяем, что мы вообще в git-репозитории
    r = _run(["git", "rev-parse", "--is-inside-work-tree"])
    if r.returncode != 0:
        print("[git] не git-репозиторий, пропускаем")
        return False

    # 1) git add
    add_targets = [str(SERVERS_FILE)]
    if STATE_FILE.exists():
        add_targets.append(str(STATE_FILE))
    r = _run(["git", "add"] + add_targets)
    if r.returncode != 0:
        print(f"[git] add failed: {r.stderr.strip()}")
        return False

    # 2) есть ли что коммитить?
    if not _git_has_staged_changes():
        print("[git] нет изменений для коммита")
        return False

    # 3) commit
    r = _run(["git", "commit", "-m", message], timeout=60)
    if r.returncode != 0:
        print(f"[git] commit failed: {(r.stdout + r.stderr).strip()[:400]}")
        return False
    print(f"[git] commit ok: {message}")

    # 4) проверяем remote
    if not _git_has_remote(GIT_REMOTE):
        print(f"[git] remote '{GIT_REMOTE}' не настроен — push пропущен")
        return False

    # 5) определяем ветку
    branch = GIT_BRANCH or _git_current_branch()
    if not branch or branch == "HEAD":
        print("[git] не удалось определить текущую ветку (detached HEAD?) — push пропущен")
        return False

    # 6) push
    if _git_has_upstream(GIT_REMOTE, branch):
        push_cmd = ["git", "push", GIT_REMOTE, branch]
    else:
        # первый push — задаём upstream
        push_cmd = ["git", "push", "-u", GIT_REMOTE, branch]

    r = _run(push_cmd, timeout=120)
    if r.returncode != 0:
        print(f"[git] push failed: {(r.stdout + r.stderr).strip()[:400]}")
        return False

    print(f"[git] push ok: {GIT_REMOTE}/{branch}")
    return True


# ---------- State ----------
def load_state() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"last_commit": 0, "seen_urls": []}


def save_state(state: dict):
    STATE_FILE.write_text(json.dumps(state, indent=2), encoding="utf-8")


# ---------- Основной проход ----------
def run_scan_pass(state: dict) -> int:
    data = load_servers()
    seen = set(state.get("seen_urls", []))
    new_count = 0

    print("[shodan] получаем IP...")
    ips = get_shodan_ips()
    print(f"[shodan] получено {len(ips)} IP")

    targets = []
    for ip in ips:
        url = f"http://{ip}:{OLLAMA_PORT}"
        if _norm_url(url) in seen:
            continue
        if not is_public_ip(ip):
            print(f"[skip] не публичный IP: {ip}")
            seen.add(_norm_url(url))
            continue
        targets.append(ip)

    print(f"[scan] проверяем {len(targets)} публичных IP")

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        futures = {ex.submit(check_ollama_server, ip): ip for ip in targets}
        for fut in as_completed(futures):
            ip = futures[fut]
            url = f"http://{ip}:{OLLAMA_PORT}"
            seen.add(_norm_url(url))
            info = fut.result()
            if not info:
                continue
            if server_exists(data, url):
                print(f"[=] уже в servers.yaml: {url}")
                continue
            entry = make_server_entry(url, info)
            data["servers"].append(entry)
            new_count += 1
            print(f"[+] добавлен: {url} ({info['model_count']} моделей)")

    if new_count:
        save_servers(data)
        print(f"[yaml] сохранено {new_count} новых серверов")

    state["seen_urls"] = sorted(seen)
    save_state(state)
    return new_count


# ---------- main ----------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true",
                    help="Один проход поиска, затем commit+push и выход")
    ap.add_argument("--interval", type=int, default=CHECK_INTERVAL,
                    help="Интервал между проходами в loop-режиме (сек)")
    args = ap.parse_args()

    state = load_state()

    # ---------- --once ----------
    if args.once:
        print("[once] один проход поиска...")
        try:
            n = run_scan_pass(state)
        except Exception as e:
            print(f"[!] scan pass error: {e}")
            n = 0
        print(f"[once] новых серверов: {n}")

        msg = (f"hunter(once): +{n} Ollama servers "
               f"@ {datetime.now().isoformat(timespec='seconds')}")
        ok = git_commit_and_push(msg)
        print(f"[once] git_commit_and_push -> {ok}")
        print("[once] done")
        return

    # ---------- loop ----------
    stop = {"flag": False}

    def _sig(sig, frame):
        stop["flag"] = True
        print("\n[!] остановка по сигналу")
    signal.signal(signal.SIGINT, _sig)

    last_commit_ts = state.get("last_commit", 0)

    while not stop["flag"]:
        try:
            n = run_scan_pass(state)
        except Exception as e:
            print(f"[!] scan pass error: {e}")
            n = 0

        now = time.time()
        if n > 0 and (now - last_commit_ts >= COMMIT_INTERVAL):
            msg = (f"hunter: auto-add {n} Ollama servers "
                   f"@ {datetime.now().isoformat(timespec='seconds')}")
            if git_commit_and_push(msg):
                last_commit_ts = now
                state["last_commit"] = last_commit_ts
                save_state(state)

        print(f"[*] следующий проход через {args.interval}s")
        for _ in range(args.interval):
            if stop["flag"]:
                break
            time.sleep(1)

    git_commit_and_push(f"hunter: final commit @ {datetime.now().isoformat(timespec='seconds')}")
    print("done")


if __name__ == "__main__":
    main()
