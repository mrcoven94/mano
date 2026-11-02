"""Live proof that a Mano desktop is sealed, on throwaway Modal resources.

Run from this directory: modal run prove.py --out /some/dir. It needs a
Modal account and nothing else: no secret, no deploy, synthetic people only.
It runs the service's own create_session and delete_session (from app.py)
inside an ephemeral app, with a made-up token and profile key, against two
stand-in sites it starts itself: a portal and an off-site recorder that
logs every request it receives. It checks:

- control routes refuse callers without the session secret;
- the sandbox sees only its own person's volume, never another's;
- the network reaches only the portal host;
- redirects, redirect chains, meta refresh, popups, form posts, typed
  addresses and file:// pages that leave the portal send nothing, both with
  the production network rule and with the Chromium policy alone;
- delete stops the sandbox and drops the record.

It deletes the volumes and stops the sandboxes it made. Results print as
JSON; screenshots land in --out.
"""

import asyncio
import io
import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from types import SimpleNamespace

import modal

proof = modal.App("mano-computer-proof")
runner = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("fastapi")
    .add_local_file(Path(__file__).parent / "app.py", "/root/manoapp.py")
)
stand_in_image = modal.Image.debian_slim(python_version="3.12")

STAND_IN = r'''
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

OTHER = sys.argv[1] if len(sys.argv) > 1 else ""
PAGES = {
    "/apply": (200, {}, "<h1>Synthetic renewal</h1>"),
    "/redirect": (302, {"Location": OTHER + "/redirected"}, ""),
    "/chain": (302, {"Location": "/redirect"}, ""),
    "/meta": (200, {}, '<meta http-equiv="refresh" content="0;url=%s/meta">' % OTHER),
    "/popup": (200, {}, '<button style="position:fixed;inset:0;width:100%%;height:100%%" onclick="fetch(\'/clicked\');window.open(\'%s/popup\')">Open</button>' % OTHER),
    "/form": (200, {}, '<form method="post" action="%s/form"><input name="household" value="synthetic"></form><script>fetch("/loaded").then(() => document.forms[0].submit())</script>' % OTHER),
    "/subresources": (200, {}, '<img src="%s/img.png"><script>fetch("%s/fetch").finally(() => fetch("/subresources-done"))</script>' % (OTHER, OTHER)),
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def respond(self):
        path = self.path.split("?")[0]
        if path != "/hits":
            with open("/tmp/hits.log", "a") as log:
                log.write("%s %s\n" % (self.command, path))
        status, headers, body = PAGES.get(path, (200, {}, "ok"))
        if path == "/hits":
            try:
                body = open("/tmp/hits.log").read()
            except FileNotFoundError:
                body = ""
        data = body.encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(data)))
        for name, value in headers.items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(data)

    do_GET = respond
    do_POST = respond


ThreadingHTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
'''

# Probes run inside the desktop sandbox. They print, never raise.
FETCH = r'''
import sys, urllib.request
for url in sys.argv[1:]:
    try:
        with urllib.request.urlopen(url, timeout=10) as r:
            print(url, r.status)
    except Exception as e:
        print(url, "refused", type(e).__name__)
'''


class Request:
    def __init__(self, body, headers):
        self.headers = headers
        self._body = body

    async def json(self):
        return self._body


class MemoryDict:
    """Keeps the proof away from the live service's session Dict."""

    def __init__(self):
        self.data = {}

        async def put(key, value):
            self.data[key] = value

        async def get(key, default=None):
            return self.data.get(key, default)

        async def pop(key):
            return self.data.pop(key)

        self.put = SimpleNamespace(aio=put)
        self.get = SimpleNamespace(aio=get)
        self.pop = SimpleNamespace(aio=pop)


def http(method, url, body=None, secret=None):
    headers = {"content-type": "application/json"}
    if secret is not None:
        headers["authorization"] = "Bearer " + secret
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return res.status, res.read()
    except urllib.error.HTTPError as err:
        err.close()
        return err.code, b""


def wait_up(url, timeout=120):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=5):
                return
        except Exception:
            time.sleep(2)
    raise TimeoutError(url)


async def start_stand_in(other=""):
    sb = await modal.Sandbox.create.aio("python3", "-c", STAND_IN, other, image=stand_in_image, encrypted_ports=[8000], timeout=1500)
    url = (await sb.tunnels.aio())[8000].url
    # /hits is never logged, so readiness checks leave no trace in the record.
    await asyncio.to_thread(wait_up, url + "/hits")
    return sb, url


async def run_in(sb, *argv):
    proc = await sb.exec.aio(*argv)
    await proc.wait.aio()
    return (await proc.stdout.read.aio()).strip()


async def hits(offsite_url):
    _, body = await asyncio.to_thread(http, "GET", offsite_url + "/hits")
    return [line for line in body.decode().splitlines() if line]


async def leave_the_portal(control, secret, portal_url, offsite_url):
    """Every way a page or the model could take the browser off the portal."""
    shots = {}
    steps = [
        ("redirect", ("POST", "/goto", {"url": portal_url + "/redirect"})),
        ("chain", ("POST", "/goto", {"url": portal_url + "/chain"})),
        ("meta_refresh", ("POST", "/goto", {"url": portal_url + "/meta"})),
        ("form_post", ("POST", "/goto", {"url": portal_url + "/form"})),
        ("popup", ("POST", "/goto", {"url": portal_url + "/popup"})),
        ("popup_click", ("POST", "/act", {"actions": [{"type": "click", "button": "left", "x": 640, "y": 400}]})),
        ("typed_address", ("POST", "/act", {"actions": [{"type": "keypress", "keys": ["ctrl", "l"]}, {"type": "type", "text": offsite_url + "/typed"}, {"type": "keypress", "keys": ["Enter"]}]})),
        ("typed_file", ("POST", "/act", {"actions": [{"type": "keypress", "keys": ["ctrl", "l"]}, {"type": "type", "text": "file:///profile/"}, {"type": "keypress", "keys": ["Enter"]}]})),
    ]
    statuses = {}
    for name, (method, path, body) in steps:
        statuses[name], _ = await asyncio.to_thread(http, method, control + path, body, secret)
        await asyncio.sleep(4)
        if name in ("redirect", "typed_address", "typed_file"):
            _, shots[name] = await asyncio.to_thread(http, "GET", control + "/screenshot", None, secret)
    return statuses, shots


@proof.function(image=runner, timeout=2400)
async def prove():
    sys.path.insert(0, "/root")
    import manoapp as app

    app.sessions = MemoryDict()
    token = secrets.token_urlsafe(24)
    key = secrets.token_urlsafe(24)
    auth = {"authorization": "Bearer " + token}
    results = {}
    shots = {}
    made = []

    offsite, offsite_url = await start_stand_in()
    portal, portal_url = await start_stand_in(offsite_url)
    os.environ.update({"MANO_COMPUTER_TOKEN": token, "MANO_PROFILE_KEY": key, "MANO_PORTAL_ORIGIN": portal_url})
    offsite_host = offsite_url.removeprefix("https://")

    try:
        other = "synthetic-person-b"
        vol_b = modal.Volume.from_name(app.profile_volume_name(other, key), create_if_missing=True)
        made.append(app.profile_volume_name(other, key))
        async with vol_b.batch_upload.aio() as batch:
            batch.put_file(io.BytesIO(b"synthetic person b"), "/marker-b.txt")
        results["b_volume_has_marker"] = [e.path for e in await vol_b.listdir.aio("/")]

        res = await app.create_session(Request({"person_id": "synthetic-person-a"}, {}))
        results["create_without_service_token"] = res.status_code
        res = await app.create_session(Request({}, auth))
        results["create_without_person_id"] = res.status_code

        made.append(app.profile_volume_name("synthetic-person-a", key))
        res = await app.create_session(Request({"person_id": "synthetic-person-a"}, auth))
        results["create_a"] = res.status_code
        session = json.loads(res.body)
        control, secret = session["control_url"], session["session_secret"]
        results["session_record"] = {"values_are_sandbox_ids": all(v.startswith("sb-") for v in app.sessions.data.values()), "holds_secret": secret in json.dumps(app.sessions.data)}
        sb = await modal.Sandbox.from_id.aio(app.sessions.data[session["id"]])

        unauthenticated = {}
        for method, path, body in (
            ("GET", "/health", None),
            ("GET", "/screenshot", None),
            ("POST", "/act", {"actions": [{"type": "type", "text": "synthetic"}]}),
            ("POST", "/goto", {"url": portal_url + "/apply"}),
            ("POST", "/stage", {"name": "a.pdf", "data_base64": "JVBERg=="}),
        ):
            for label, presented in (("none", None), ("wrong", "not-the-secret")):
                unauthenticated["%s %s %s" % (method, path, label)] = (await asyncio.to_thread(http, method, control + path, body, presented))[0]
        results["control_without_secret"] = unauthenticated
        results["goto_offsite_with_secret"] = (await asyncio.to_thread(http, "POST", control + "/goto", {"url": offsite_url + "/goto"}, secret))[0]
        results["goto_portal_with_secret"] = (await asyncio.to_thread(http, "POST", control + "/goto", {"url": portal_url + "/apply"}, secret))[0]

        results["isolation"] = {
            "ls_root": await run_in(sb, "ls", "/"),
            "ls_profiles": await run_in(sb, "sh", "-c", "ls /profiles 2>&1 || true"),
            "find_marker_b": await run_in(sb, "sh", "-c", "find / -name marker-b.txt -not -path '/proc/*' 2>/dev/null || true"),
            "ls_profile": await run_in(sb, "ls", "/profile"),
        }
        results["network_from_sandbox"] = await run_in(sb, "python3", "-c", FETCH, portal_url + "/apply", offsite_url + "/direct", "https://example.com/")

        statuses, shot_a = await leave_the_portal(control, secret, portal_url, offsite_url)
        await asyncio.to_thread(http, "POST", control + "/goto", {"url": portal_url + "/subresources"}, secret)
        await asyncio.sleep(5)
        results["production_steps"] = statuses
        results["production_offsite_hits"] = await hits(offsite_url)
        results["portal_hits"] = await hits(portal_url)
        shots.update({"production_" + k: v for k, v in shot_a.items()})

        res = await app.delete_session(session["id"], Request(None, auth))
        results["delete_a"] = res.status_code
        results["record_after_delete"] = app.sessions.data
        results["sandbox_exit_after_delete"] = await sb.poll.aio()

        # The Chromium policy alone: the same desktop with the off-site host
        # opened at the network layer, so only the policy stands in the way.
        real_sandbox = modal.Sandbox

        async def create_with_offsite(*args, **kwargs):
            kwargs["outbound_domain_allowlist"] = [*kwargs["outbound_domain_allowlist"], offsite_host]
            return await real_sandbox.create.aio(*args, **kwargs)

        modal.Sandbox = SimpleNamespace(create=SimpleNamespace(aio=create_with_offsite), from_id=real_sandbox.from_id)
        try:
            made.append(app.profile_volume_name("synthetic-person-c", key))
            res = await app.create_session(Request({"person_id": "synthetic-person-c"}, auth))
        finally:
            modal.Sandbox = real_sandbox
        results["create_c_policy_only"] = res.status_code
        session_c = json.loads(res.body)
        sb_c = await modal.Sandbox.from_id.aio(app.sessions.data[session_c["id"]])
        results["policy_only_network_reaches_offsite"] = await run_in(sb_c, "python3", "-c", FETCH, offsite_url + "/network-check")
        before = len(await hits(offsite_url))
        statuses, shot_c = await leave_the_portal(session_c["control_url"], session_c["session_secret"], portal_url, offsite_url)
        results["policy_only_steps"] = statuses
        results["policy_only_navigation_hits"] = (await hits(offsite_url))[before:]
        await asyncio.to_thread(http, "POST", session_c["control_url"] + "/goto", {"url": portal_url + "/subresources"}, session_c["session_secret"])
        await asyncio.sleep(5)
        results["policy_only_after_subresources"] = (await hits(offsite_url))[before:]
        shots.update({"policy_only_" + k: v for k, v in shot_c.items()})
        res = await app.delete_session(session_c["id"], Request(None, auth))
        results["delete_c"] = res.status_code
    finally:
        for sid, sandbox_id in list(app.sessions.data.items()):
            await app.delete_session(sid, Request(None, auth))
        for sb_left in (offsite, portal):
            await sb_left.terminate.aio()
        for name in made:
            await modal.Volume.objects.delete.aio(name, allow_missing=True)
        results["volumes_deleted"] = len(made)
    return results, shots


@proof.local_entrypoint()
def main(out: str = "."):
    results, shots = prove.remote()
    print(json.dumps(results, indent=2))
    Path(out).mkdir(parents=True, exist_ok=True)
    for name, png in shots.items():
        (Path(out) / ("%s.png" % name)).write_bytes(png)
