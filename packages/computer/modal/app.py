"""Mano computer service: hosted desktops on Modal Sandboxes.

Each session is one Sandbox running an Xvfb desktop with Chromium and the
control server that answers the REST contract. There is no live view.

Access. POST and DELETE /sessions need MANO_COMPUTER_TOKEN as a bearer
token. POST /sessions answers with a per-session secret, made for that
session and returned only to that caller; every control route needs it as
a bearer token. The service keeps only the sandbox id, and the sandbox
holds only the secret's SHA-256, so neither can hand the secret out.

Storage. Each person's browser profile is its own Modal volume, mounted at
/profile and nothing else. The volume name is an HMAC-SHA256 of the Engine
person id under MANO_PROFILE_KEY, so ids never collapse into one profile
and a name does not reveal the id. A request without a person id is refused.

Network. The sandbox may reach only the host of MANO_PORTAL_ORIGIN (Modal's
outbound domain allowlist), and a Chromium managed policy blocks every
other origin, so a redirect, popup or form post elsewhere is refused before
a request leaves. The origin is service configuration, never request data.

Configure. The mano-computer Modal secret holds MANO_COMPUTER_TOKEN,
MANO_PROFILE_KEY and MANO_PORTAL_ORIGIN (set in the Modal dashboard, never
on a command line). Deploy with `modal deploy app.py` from this directory;
the printed web URL is MODAL_COMPUTER_URL and the token is
MODAL_COMPUTER_TOKEN for the TypeScript client. Sandboxes stop when the
session is deleted, or after one hour; there is no idle timeout because
tunnel traffic may not count as activity.

Test. python -m unittest discover -s packages/computer/modal (needs the
modal client and fastapi; no Modal account).

The desktop scripts live in this file as literals: sandbox images build
lazily inside whatever container first requests them, where sibling files
are missing, so add_local_file cannot ship them. Edit CONTROL_PY and
START_SH here.
"""

import asyncio
import hashlib
import hmac
import json
import os
import secrets
import time
import urllib.parse
import urllib.request
from typing import NamedTuple

import modal
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

CONTROL_PY = '''#!/usr/bin/env python3
"""Control server inside a Mano desktop sandbox.

Speaks the session REST contract over plain HTTP on port 8001: screenshots
out, mouse and keyboard in, files staged for pickers. Every route needs the
session secret as a bearer token; this sandbox knows only its SHA-256.
Standard library only. Every action runs through xdotool against the Xvfb
screen Chromium fills.
"""

import base64
import hashlib
import json
import os
import secrets
import subprocess
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DISPLAY = os.environ.get("DISPLAY", ":99")
UPLOADS = "/uploads"
SCREENSHOT_PATH = "/tmp/shot.png"
SECRET_SHA256 = os.environ.get("MANO_SESSION_SECRET_SHA256", "")
PORTAL_ORIGIN = os.environ.get("MANO_PORTAL_ORIGIN", "")

KEY_NAMES = {
    "Enter": "Return",
    "ArrowLeft": "Left",
    "ArrowRight": "Right",
    "ArrowUp": "Up",
    "ArrowDown": "Down",
    " ": "space",
}

MODIFIERS = {"ctrl": "ctrl", "control": "ctrl", "meta": "Super", "super": "Super", "shift": "shift", "alt": "alt"}


def authorized_header(presented, expected_sha256):
    if not expected_sha256 or not presented.startswith("Bearer "):
        return False
    token = presented[len("Bearer "):]
    if not token:
        return False
    return secrets.compare_digest(hashlib.sha256(token.encode()).hexdigest(), expected_sha256)


def origin_of(url):
    if any(c <= " " for c in url):
        return None
    try:
        parts = urllib.parse.urlsplit(url)
        port = parts.port
    except ValueError:
        return None
    if parts.scheme != "https" or not parts.hostname:
        return None
    return "https://" + parts.hostname + ("" if port in (None, 443) else ":%d" % port)


def key_name(key):
    if key in KEY_NAMES:
        return KEY_NAMES[key]
    return MODIFIERS.get(key.lower(), key)


def run(*args):
    return subprocess.run(
        args, env={**os.environ, "DISPLAY": DISPLAY}, capture_output=True, timeout=20, check=True
    )


def click_button(button):
    return {"left": "1", "right": "3", "wheel": "2", "back": "8", "forward": "9"}[button]


def apply_action(action):
    kind = action.get("type")
    if kind == "click":
        run("xdotool", "mousemove", str(action["x"]), str(action["y"]),
            "click", click_button(action.get("button", "left")))
    elif kind == "double_click":
        run("xdotool", "mousemove", str(action["x"]), str(action["y"]),
            "click", "--repeat", "2", "1")
    elif kind == "drag":
        path = action.get("path", [])
        if not path:
            raise ValueError("drag needs at least one point")
        run("xdotool", "mousemove", str(path[0]["x"]), str(path[0]["y"]), "mousedown", "1")
        try:
            for point in path[1:]:
                run("xdotool", "mousemove", str(point["x"]), str(point["y"]))
        finally:
            run("xdotool", "mouseup", "1")
    elif kind == "keypress":
        keys = "+".join(key_name(k) for k in action.get("keys", []))
        if not keys:
            raise ValueError("keypress needs at least one key")
        run("xdotool", "key", keys)
    elif kind == "move":
        run("xdotool", "mousemove", str(action["x"]), str(action["y"]))
    elif kind == "scroll":
        run("xdotool", "mousemove", str(action["x"]), str(action["y"]))
        dx = action.get("scroll_x", 0)
        dy = action.get("scroll_y", 0)
        for button, amount in (("4", -dy), ("5", dy), ("7", -dx), ("6", dx)):
            for _ in range(max(0, round(amount / 50))):
                run("xdotool", "click", button)
    elif kind == "type":
        run("xdotool", "type", "--delay", "5", "--", action.get("text", ""))
    elif kind == "screenshot":
        pass
    elif kind == "wait":
        time.sleep(1.5)
    else:
        raise ValueError("unknown action %r" % (kind,))


def screenshot_bytes():
    run("scrot", "-o", "-z", SCREENSHOT_PATH)
    with open(SCREENSHOT_PATH, "rb") as handle:
        return handle.read()


def safe_name(name):
    cleaned = "".join(c if c.isalnum() or c in "._-" else "_" for c in name).strip("._")
    return cleaned or "upload"


class Handler(BaseHTTPRequestHandler):
    server_version = "mano-control/1"

    def log_message(self, *args):
        pass

    def read_json(self):
        length = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(length) or b"{}")

    def send_json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def authorized(self):
        if authorized_header(self.headers.get("Authorization", ""), SECRET_SHA256):
            return True
        self.send_json(401, {"error": "unauthorized"})
        return False

    def do_GET(self):
        if not self.authorized():
            return
        path = urllib.parse.urlparse(self.path).path
        if path == "/health":
            self.send_json(200, {"ok": True})
        elif path == "/screenshot":
            try:
                png = screenshot_bytes()
            except Exception as exc:
                self.send_json(500, {"error": str(exc)})
                return
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(png)))
            self.end_headers()
            self.wfile.write(png)
        else:
            self.send_json(404, {"error": "no route"})

    def do_POST(self):
        if not self.authorized():
            return
        path = urllib.parse.urlparse(self.path).path
        try:
            if path == "/act":
                actions = self.read_json().get("actions", [])
                applied = 0
                try:
                    for action in actions:
                        apply_action(action)
                        applied += 1
                except Exception as exc:
                    self.send_json(422, {"applied": applied, "error": str(exc)})
                    return
                self.send_json(200, {"applied": applied})
            elif path == "/goto":
                url = str(self.read_json().get("url", ""))
                if not PORTAL_ORIGIN or origin_of(url) != PORTAL_ORIGIN:
                    self.send_json(403, {"error": "only the portal may be opened"})
                    return
                run("xdotool", "key", "ctrl+l")
                time.sleep(0.3)
                run("xdotool", "type", "--delay", "5", "--", url)
                run("xdotool", "key", "Return")
                self.send_json(200, {})
            elif path == "/stage":
                body = self.read_json()
                name = safe_name(str(body.get("name", "")))
                data = base64.b64decode(body.get("data_base64", ""))
                os.makedirs(UPLOADS, exist_ok=True)
                dest = os.path.join(UPLOADS, name)
                with open(dest, "wb") as handle:
                    handle.write(data)
                self.send_json(200, {"path": dest})
            else:
                self.send_json(404, {"error": "no route"})
        except Exception as exc:
            self.send_json(500, {"error": str(exc)})


if __name__ == "__main__":
    # All interfaces: the tunnel proxy reaches the sandbox from outside, so
    # localhost would refuse it.
    ThreadingHTTPServer(("0.0.0.0", 8001), Handler).serve_forever()
'''

START_SH = '''#!/bin/sh
# Boot one Mano desktop: Xvfb screen, window manager, Chromium, control server.
set -eu
WIDTH=${WIDTH:-1280}
HEIGHT=${HEIGHT:-800}
export DISPLAY=:99
mkdir -p /etc/chromium/policies/managed
printf '%s' "$MANO_CHROMIUM_POLICY" > /etc/chromium/policies/managed/mano.json
Xvfb :99 -screen 0 "${WIDTH}x${HEIGHT}x24" >/tmp/xvfb.log 2>&1 &
sleep 1
fluxbox >/tmp/fluxbox.log 2>&1 &
mkdir -p /uploads
python3 /root/control.py &
unset MANO_SESSION_SECRET_SHA256 MANO_CHROMIUM_POLICY
# A desktop that died mid-filing leaves a crashed profile behind; scrub the
# crash markers so Chromium never opens a restore bubble over the page. (The
# --disable-session-crashed-bubble flag no longer suppresses it.) Stale
# singleton locks are safe to drop: this sandbox is always a fresh machine.
PREF="/profile/Default/Preferences"
if [ -f "$PREF" ]; then
  sed -i 's/"exited_cleanly":false/"exited_cleanly":true/;s/"exit_type":"Crashed"/"exit_type":"Normal"/' "$PREF"
fi
rm -f /profile/Default/SingletonLock /profile/Default/SingletonSocket /profile/Default/SingletonCookie
chromium --no-sandbox --disable-dev-shm-usage --disable-gpu --no-first-run --no-default-browser-check \\
  --user-data-dir=/profile \\
  --window-size="${WIDTH},${HEIGHT}" --window-position=0,0 --start-maximized \\
  about:blank >/tmp/chromium.log 2>&1 &
wait
'''

desktop = modal.Image.debian_slim(python_version="3.12").apt_install("xvfb", "fluxbox", "chromium", "xdotool", "scrot")

service = modal.Image.debian_slim(python_version="3.12").pip_install("fastapi")

app = modal.App("mano-computer")
sessions = modal.Dict.from_name("mano-computer-sessions", create_if_missing=True)
api_secret = modal.Secret.from_name(
    "mano-computer", required_keys=["MANO_COMPUTER_TOKEN", "MANO_PROFILE_KEY", "MANO_PORTAL_ORIGIN"]
)

SANDBOX_TIMEOUT = 60 * 60
CONTROL_PORT = 8001
PROFILE_PATH = "/profile"
MAX_PERSON_ID = 256


class Portal(NamedTuple):
    origin: str
    host: str
    port: int | None


def parse_portal_origin(value: str) -> Portal:
    try:
        parts = urllib.parse.urlsplit(value)
        port = parts.port
    except ValueError as exc:
        raise ValueError("MANO_PORTAL_ORIGIN is not a URL") from exc
    if (
        parts.scheme != "https"
        or not parts.hostname
        or parts.username is not None
        or parts.query
        or parts.fragment
        or parts.path not in ("", "/")
    ):
        raise ValueError("MANO_PORTAL_ORIGIN must be an https origin such as https://portal.example.org")
    port = None if port in (None, 443) else port
    host = parts.hostname
    return Portal("https://" + host + (":%d" % port if port else ""), host, port)


def chromium_policy(portal: Portal) -> dict:
    """URLBlocklist covers navigations of every kind (typed, redirected,
    popups, form posts, file://). The leading dot keeps subdomains out."""
    exact = "https://." + portal.host + (":%d" % portal.port if portal.port else "")
    return {"URLBlocklist": ["*"], "URLAllowlist": [exact], "DeveloperToolsAvailability": 2}


def profile_volume_name(person_id: str, key: str) -> str:
    if not person_id or not key:
        raise ValueError("a profile needs a person id and MANO_PROFILE_KEY")
    digest = hmac.new(key.encode(), person_id.encode(), hashlib.sha256).hexdigest()
    # 192 bits keeps the name inside Modal's 64-character limit.
    return "mano-profile-" + digest[:48]


def sandbox_bootstrap():
    """Write both desktop scripts, then boot. Quoted heredoc markers mean the
    shell expands nothing inside the scripts."""
    return (
        "cat > /root/control.py <<'MANO_CONTROL_EOF'\n"
        + CONTROL_PY
        + "\nMANO_CONTROL_EOF\n"
        + "cat > /root/start.sh <<'MANO_START_EOF'\n"
        + START_SH
        + "\nMANO_START_EOF\n"
        + "chmod +x /root/start.sh\nexec /root/start.sh"
    )


def wait_for_control(control_url: str, secret: str, timeout: float = 90) -> None:
    request = urllib.request.Request(control_url + "/health", headers={"Authorization": "Bearer " + secret})
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(request, timeout=5) as res:
                if res.status == 200:
                    return
        except Exception:
            time.sleep(2)
    raise TimeoutError("desktop control server never came up")


async def wait_for_chromium(sb, timeout: float = 60) -> None:
    """A session is not ready until Chromium's window is visible, or the
    first screenshot is an empty desktop and the model's first clicks miss."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        proc = await sb.exec.aio("xdotool", "search", "--onlyvisible", "--class", "Chromium", env={"DISPLAY": ":99"})
        if await proc.wait.aio() == 0:
            return
        await asyncio.sleep(2)
    raise TimeoutError("chromium window never appeared")


async def wait_until_ready(sb, control_url: str, secret: str) -> None:
    await asyncio.to_thread(wait_for_control, control_url, secret)
    await wait_for_chromium(sb)


async def terminate_quietly(sb) -> None:
    try:
        await sb.terminate.aio()
    except Exception:
        pass


web = FastAPI()


def refuse(status: int, message: str) -> JSONResponse:
    return JSONResponse({"error": message}, status_code=status)


def authorized(request: Request) -> bool:
    token = os.environ.get("MANO_COMPUTER_TOKEN", "")
    presented = request.headers.get("authorization", "")
    return bool(token) and secrets.compare_digest(presented.encode(), f"Bearer {token}".encode())


def person_from(body) -> str | None:
    person = body.get("person_id") if isinstance(body, dict) else None
    if not isinstance(person, str) or not person.strip() or len(person) > MAX_PERSON_ID:
        return None
    return person


def dimension(body: dict, name: str, default: int) -> int:
    value = body.get(name, default)
    if isinstance(value, bool) or not isinstance(value, int) or not 320 <= value <= 3840:
        raise ValueError(name)
    return value


@web.post("/sessions")
async def create_session(request: Request):
    if not authorized(request):
        return refuse(401, "unauthorized")
    profile_key = os.environ.get("MANO_PROFILE_KEY", "")
    try:
        portal = parse_portal_origin(os.environ.get("MANO_PORTAL_ORIGIN", ""))
    except ValueError:
        portal = None
    if portal is None or not profile_key:
        return refuse(503, "the computer service is not configured")
    try:
        body = await request.json()
    except Exception:
        return refuse(400, "the body must be JSON")
    person = person_from(body)
    if person is None:
        return refuse(400, "person_id is required")
    try:
        width = dimension(body, "width", 1280)
        height = dimension(body, "height", 800)
    except ValueError as exc:
        return refuse(400, "%s is out of range" % exc)

    secret = secrets.token_urlsafe(32)
    sid = secrets.token_hex(16)
    try:
        sb = await modal.Sandbox.create.aio(
            "bash",
            "-c",
            sandbox_bootstrap(),
            image=desktop,
            volumes={PROFILE_PATH: modal.Volume.from_name(profile_volume_name(person, profile_key), create_if_missing=True)},
            env={
                "WIDTH": str(width),
                "HEIGHT": str(height),
                "MANO_SESSION_SECRET_SHA256": hashlib.sha256(secret.encode()).hexdigest(),
                "MANO_PORTAL_ORIGIN": portal.origin,
                "MANO_CHROMIUM_POLICY": json.dumps(chromium_policy(portal)),
            },
            outbound_domain_allowlist=[portal.host],
            timeout=SANDBOX_TIMEOUT,
            cpu=2.0,
            memory=4096,
            encrypted_ports=[CONTROL_PORT],
        )
    except Exception:
        return refuse(503, "the desktop did not start")
    try:
        control_url = (await sb.tunnels.aio())[CONTROL_PORT].url
        await wait_until_ready(sb, control_url, secret)
        await sessions.put.aio(sid, sb.object_id)
    except BaseException as exc:
        await terminate_quietly(sb)
        if isinstance(exc, Exception):
            return refuse(503, "the desktop did not start")
        raise
    return JSONResponse({"id": sid, "control_url": control_url, "session_secret": secret})


@web.delete("/sessions/{sid}")
async def delete_session(sid: str, request: Request):
    if not authorized(request):
        return refuse(401, "unauthorized")
    sandbox_id = await sessions.get.aio(sid)
    if sandbox_id is None:
        return refuse(404, "unknown session")
    try:
        sb = await modal.Sandbox.from_id.aio(sandbox_id)
        await sb.terminate.aio(wait=True)
    except (modal.exception.NotFoundError, modal.exception.SandboxTerminatedError, modal.exception.SandboxTimeoutError):
        pass
    except Exception:
        # The record stays so a retry can still find and stop the desktop.
        return refuse(502, "termination not confirmed")
    try:
        await sessions.pop.aio(sid)
    except KeyError:
        pass
    return JSONResponse({})


@app.function(image=service, timeout=300, secrets=[api_secret])
@modal.asgi_app()
def api():
    return web
