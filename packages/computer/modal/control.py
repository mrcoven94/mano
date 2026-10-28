#!/usr/bin/env python3
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
    ThreadingHTTPServer(("127.0.0.1", 8001), Handler).serve_forever()
