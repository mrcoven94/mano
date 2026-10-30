"""Mano computer service: hosted desktops on Modal Sandboxes.

Deploy once with `modal deploy app.py` from this directory, after creating
the mano-computer secret holding MANO_COMPUTER_TOKEN in the Modal dashboard
(never on a command line); the printed web URL is MODAL_COMPUTER_URL and the
token is MODAL_COMPUTER_TOKEN for the TypeScript client. Each session is one
Sandbox running an Xvfb desktop with Chromium, a VNC live view, and the
control server answering the REST contract. Browser profiles persist per
person in the mano-profiles volume. Sandboxes stop when the session is
deleted, or after one hour; there is no idle timeout because tunnel
traffic may not count as activity, and a desktop must never die mid-filing.

The desktop scripts live in this file as literals: sandbox images build
lazily inside whatever container first requests them, where sibling files
are missing, so add_local_file cannot ship them. Edit CONTROL_PY and
START_SH here.
"""

import asyncio
import os
import secrets
import time
import urllib.request

import modal
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

CONTROL_PY = '''#!/usr/bin/env python3
"""Control server inside a Mano desktop sandbox.

Speaks the session REST contract over plain HTTP on port 8001: screenshots
out, mouse and keyboard in, files staged for pickers. Standard library only.
Every action runs through xdotool against the Xvfb screen Chromium fills.
"""

import base64
import json
import os
import subprocess
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DISPLAY = os.environ.get("DISPLAY", ":99")
UPLOADS = "/uploads"
SCREENSHOT_PATH = "/tmp/shot.png"

KEY_NAMES = {
    "Enter": "Return",
    "ArrowLeft": "Left",
    "ArrowRight": "Right",
    "ArrowUp": "Up",
    "ArrowDown": "Down",
    " ": "space",
}

MODIFIERS = {"ctrl": "ctrl", "control": "ctrl", "meta": "Super", "super": "Super", "shift": "shift", "alt": "alt"}


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

    def do_GET(self):
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
                url = self.read_json().get("url", "")
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
    # localhost would refuse it. The port leaves the sandbox only through the
    # session's own unguessable tunnel URL.
    ThreadingHTTPServer(("0.0.0.0", 8001), Handler).serve_forever()
'''

START_SH = '''#!/bin/sh
# Boot one Mano desktop: Xvfb screen, window manager, Chromium, live view, control server.
set -eu
WIDTH=${WIDTH:-1280}
HEIGHT=${HEIGHT:-800}
PROFILE=${PROFILE:-default}
export DISPLAY=:99
Xvfb :99 -screen 0 "${WIDTH}x${HEIGHT}x24" >/tmp/xvfb.log 2>&1 &
sleep 1
fluxbox >/tmp/fluxbox.log 2>&1 &
x11vnc -display :99 -forever -shared -rfbport 5900 -nopw -quiet >/tmp/x11vnc.log 2>&1 &
websockify --web /usr/share/novnc 6080 localhost:5900 >/tmp/novnc.log 2>&1 &
mkdir -p /uploads
python3 /root/control.py &
mkdir -p "/profiles/${PROFILE}"
# A desktop that died mid-filing leaves a crashed profile behind; scrub the
# crash markers so Chromium never opens a restore bubble over the page. (The
# --disable-session-crashed-bubble flag no longer suppresses it.) Stale
# singleton locks are safe to drop: this sandbox is always a fresh machine.
PREF="/profiles/${PROFILE}/Default/Preferences"
if [ -f "$PREF" ]; then
  sed -i 's/"exited_cleanly":false/"exited_cleanly":true/;s/"exit_type":"Crashed"/"exit_type":"Normal"/' "$PREF"
fi
rm -f "/profiles/${PROFILE}/Default/SingletonLock" "/profiles/${PROFILE}/Default/SingletonSocket" "/profiles/${PROFILE}/Default/SingletonCookie"
chromium --no-sandbox --disable-dev-shm-usage --disable-gpu --no-first-run --no-default-browser-check \\
  --user-data-dir="/profiles/${PROFILE}" \\
  --window-size="${WIDTH},${HEIGHT}" --window-position=0,0 --start-maximized \\
  about:blank >/tmp/chromium.log 2>&1 &
wait
'''

desktop = modal.Image.debian_slim(python_version="3.12").apt_install(
    "xvfb", "fluxbox", "chromium", "xdotool", "scrot", "x11vnc", "novnc", "websockify"
)

service = modal.Image.debian_slim(python_version="3.12").pip_install("fastapi")

app = modal.App("mano-computer")
profiles = modal.Volume.from_name("mano-profiles", create_if_missing=True)
sessions = modal.Dict.from_name("mano-computer-sessions", create_if_missing=True)
# MANO_COMPUTER_TOKEN: the bearer token every session call must carry. A
# session opens a person's browser profile, so the service never runs open.
api_secret = modal.Secret.from_name("mano-computer", required_keys=["MANO_COMPUTER_TOKEN"])

SANDBOX_TIMEOUT = 60 * 60


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


def wait_for_control(tunnels, timeout=90):
    control = tunnels[8001].url
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(control + "/health", timeout=5) as res:
                if res.status == 200:
                    return control
        except Exception:
            time.sleep(2)
    raise TimeoutError("desktop control server never came up")


async def wait_for_chromium(sb, timeout=60):
    """Chromium starts after the control server answers; a session is not
    ready until its window is visible, or the first screenshot is an empty
    desktop and the model's first clicks miss."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        proc = await sb.exec.aio("xdotool", "search", "--onlyvisible", "--class", "Chromium", env={"DISPLAY": ":99"})
        if await proc.wait.aio() == 0:
            return
        await asyncio.sleep(2)
    raise TimeoutError("chromium window never appeared")


@app.function(image=service, timeout=180)
async def spawn_desktop(width: int, height: int, profile: str):
    sb = await modal.Sandbox.create.aio(
        "bash",
        "-c",
        sandbox_bootstrap(),
        image=desktop,
        volumes={"/profiles": profiles},
        env={"WIDTH": str(width), "HEIGHT": str(height), "PROFILE": profile},
        timeout=SANDBOX_TIMEOUT,
        cpu=2.0,
        memory=4096,
        encrypted_ports=[8001, 6080],
    )
    tunnels = await sb.tunnels.aio()
    control = wait_for_control(tunnels)
    await wait_for_chromium(sb)
    return {"sandbox_id": sb.object_id, "control_url": control, "live_view_url": tunnels[6080].url + "/vnc.html"}


@app.function(image=service, timeout=120)
async def kill_desktop(sandbox_id: str):
    sb = await modal.Sandbox.from_id.aio(sandbox_id)
    await sb.terminate.aio()


web = FastAPI()


def authorized(request: Request) -> bool:
    token = os.environ.get("MANO_COMPUTER_TOKEN", "")
    presented = request.headers.get("authorization", "")
    return bool(token) and secrets.compare_digest(presented.encode(), f"Bearer {token}".encode())


@web.post("/sessions")
async def create_session(request: Request):
    if not authorized(request):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    body = await request.json()
    width = int(body.get("width", 1280))
    height = int(body.get("height", 800))
    profile = "".join(c for c in str(body.get("profile", "default")) if c.isalnum() or c in "-_") or "default"
    info = await spawn_desktop.remote.aio(width=width, height=height, profile=profile)
    sid = secrets.token_hex(8)
    sessions[sid] = info["sandbox_id"]
    return JSONResponse({"id": sid, "control_url": info["control_url"], "live_view_url": info["live_view_url"]})


@web.delete("/sessions/{sid}")
async def delete_session(sid: str, request: Request):
    if not authorized(request):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    sandbox_id = sessions.get(sid)
    if sandbox_id is None:
        return JSONResponse({"error": "unknown session"}, status_code=404)
    del sessions[sid]
    await kill_desktop.remote.aio(sandbox_id=sandbox_id)
    return JSONResponse({})


@app.function(image=service, timeout=300, secrets=[api_secret])
@modal.asgi_app()
def api():
    return web
