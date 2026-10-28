"""Mano computer service: hosted desktops on Modal Sandboxes.

Deploy once with `modal deploy app.py` from this directory; the printed web
URL is MODAL_COMPUTER_URL for the TypeScript client. Each session is one
Sandbox running start.sh: a Linux desktop with Chromium, a VNC live view,
and control.py answering the REST contract. Browser profiles persist per
person in the mano-profiles volume. Sandboxes stop after ten idle minutes.
"""

import secrets
import time
import urllib.request
from pathlib import Path

import modal
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

HERE = Path(__file__).parent

desktop = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("xvfb", "fluxbox", "chromium", "xdotool", "scrot", "x11vnc", "novnc", "websockify")
    .add_local_file(HERE / "control.py", "/root/control.py")
    .add_local_file(HERE / "start.sh", "/root/start.sh")
)

service = modal.Image.debian_slim(python_version="3.12").pip_install("fastapi")

app = modal.App("mano-computer")
profiles = modal.Volume.from_name("mano-profiles", create_if_missing=True)
sessions = modal.Dict.from_name("mano-computer-sessions", create_if_missing=True)

SANDBOX_TIMEOUT = 60 * 60
SANDBOX_IDLE_TIMEOUT = 10 * 60


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


@app.function(timeout=180)
async def spawn_desktop(width: int, height: int, profile: str):
    sb = await modal.Sandbox.create.aio(
        "/root/start.sh",
        image=desktop,
        volumes={"/profiles": profiles},
        env={"WIDTH": str(width), "HEIGHT": str(height), "PROFILE": profile},
        timeout=SANDBOX_TIMEOUT,
        idle_timeout=SANDBOX_IDLE_TIMEOUT,
        cpu=2.0,
        memory=4096,
        unencrypted_ports=[8001, 6080],
    )
    tunnels = await sb.tunnels.aio()
    control = wait_for_control(tunnels)
    return {"sandbox_id": sb.object_id, "control_url": control, "live_view_url": tunnels[6080].url + "/vnc.html"}


@app.function(timeout=120)
async def kill_desktop(sandbox_id: str):
    sb = await modal.Sandbox.from_id.aio(sandbox_id)
    await sb.terminate.aio()


web = FastAPI()


@web.post("/sessions")
async def create_session(request: Request):
    body = await request.json()
    width = int(body.get("width", 1280))
    height = int(body.get("height", 800))
    profile = "".join(c for c in str(body.get("profile", "default")) if c.isalnum() or c in "-_") or "default"
    info = await spawn_desktop.remote.aio(width=width, height=height, profile=profile)
    sid = secrets.token_hex(8)
    sessions[sid] = info["sandbox_id"]
    return JSONResponse({"id": sid, "control_url": info["control_url"], "live_view_url": info["live_view_url"]})


@web.delete("/sessions/{sid}")
async def delete_session(sid: str):
    sandbox_id = sessions.get(sid)
    if sandbox_id is None:
        return JSONResponse({"error": "unknown session"}, status_code=404)
    del sessions[sid]
    await kill_desktop.remote.aio(sandbox_id=sandbox_id)
    return JSONResponse({})


@app.function(image=service, timeout=300)
@modal.asgi_app()
def api():
    return web
