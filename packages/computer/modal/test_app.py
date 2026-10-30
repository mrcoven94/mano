# Run: pip install "modal==1.6.2" fastapi && python -m unittest discover -s packages/computer/modal
import asyncio
import hashlib
import importlib.util
import json
import os
import re
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import warnings
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

warnings.filterwarnings("ignore")
sys.path.insert(0, str(Path(__file__).parent))
import app  # noqa: E402
import modal  # noqa: E402

SERVICE_ENV = {
    "MANO_COMPUTER_TOKEN": "synthetic-service-token",
    "MANO_PROFILE_KEY": "synthetic-profile-key",
    "MANO_PORTAL_ORIGIN": "https://portal.test",
}
SERVICE_AUTH = {"authorization": "Bearer synthetic-service-token"}


def aio(fn):
    return SimpleNamespace(aio=fn)


class FakeRequest:
    def __init__(self, body=None, headers=None):
        self.headers = headers if headers is not None else dict(SERVICE_AUTH)
        self._body = body

    async def json(self):
        if isinstance(self._body, Exception):
            raise self._body
        return self._body


class FakeDict:
    def __init__(self):
        self.data = {}

        async def put(key, value):
            self.data[key] = value

        async def get(key, default=None):
            return self.data.get(key, default)

        async def pop(key):
            return self.data.pop(key)

        self.put = aio(put)
        self.get = aio(get)
        self.pop = aio(pop)


class FakeSandbox:
    def __init__(self, world, object_id):
        self.object_id = object_id
        self.world = world

        async def tunnels():
            return {8001: SimpleNamespace(url="https://control.test")}

        async def terminate(wait=False):
            if world.terminate_failures > 0:
                world.terminate_failures -= 1
                raise ConnectionError("modal api unreachable")
            world.terminated.append((object_id, wait))

        self.tunnels = aio(tunnels)
        self.terminate = aio(terminate)


class FakeModal:
    """Stands in for modal.Sandbox and modal.Volume: records every desktop."""

    def __init__(self):
        self.created = []
        self.terminated = []
        self.terminate_failures = 0
        self.gone = set()
        world = self

        async def create(*args, **kwargs):
            sb = FakeSandbox(world, "sb-%d" % len(world.created))
            world.created.append({"args": args, "kwargs": kwargs, "sandbox": sb})
            return sb

        async def from_id(sandbox_id):
            if sandbox_id in world.gone:
                raise modal.exception.NotFoundError("no such sandbox")
            return FakeSandbox(world, sandbox_id)

        self.Sandbox = SimpleNamespace(create=aio(create), from_id=aio(from_id))
        self.Volume = SimpleNamespace(from_name=lambda name, create_if_missing=False: SimpleNamespace(name=name, created=create_if_missing))


class Service(unittest.TestCase):
    def setUp(self):
        self.modal = FakeModal()
        self.sessions = FakeDict()
        self.ready_error = None

        async def ready(sb, control_url, secret):
            if self.ready_error:
                raise self.ready_error

        patches = [
            mock.patch.dict(os.environ, SERVICE_ENV),
            mock.patch.object(app.modal, "Sandbox", self.modal.Sandbox),
            mock.patch.object(app.modal, "Volume", self.modal.Volume),
            mock.patch.object(app, "sessions", self.sessions),
            mock.patch.object(app, "wait_until_ready", ready),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def create(self, body, headers=None):
        res = asyncio.run(app.create_session(FakeRequest(body, headers)))
        return res.status_code, json.loads(res.body)

    def delete(self, sid, headers=None):
        res = asyncio.run(app.delete_session(sid, FakeRequest(None, headers)))
        return res.status_code, json.loads(res.body)


class SessionSecret(Service):
    def test_session_calls_without_the_service_token_start_nothing(self):
        for headers in ({}, {"authorization": "Bearer wrong"}, {"authorization": "synthetic-service-token"}):
            status, _ = self.create({"person_id": "person-a"}, headers)
            self.assertEqual(status, 401)
        self.assertEqual(self.modal.created, [])

    def test_the_session_secret_goes_only_to_the_caller(self):
        status, body = self.create({"person_id": "person-a"})
        self.assertEqual(status, 200)
        secret = body["session_secret"]
        self.assertGreaterEqual(len(secret), 32)
        self.assertEqual(body["control_url"], "https://control.test")
        env = self.modal.created[0]["kwargs"]["env"]
        self.assertEqual(env["MANO_SESSION_SECRET_SHA256"], hashlib.sha256(secret.encode()).hexdigest())
        self.assertNotIn(secret, json.dumps(env))
        self.assertNotIn(secret, json.dumps(self.sessions.data))
        self.assertEqual(self.sessions.data, {body["id"]: "sb-0"})

    def test_each_session_gets_its_own_secret(self):
        _, first = self.create({"person_id": "person-a"})
        _, second = self.create({"person_id": "person-a"})
        self.assertNotEqual(first["session_secret"], second["session_secret"])

    def test_only_the_control_port_is_tunneled(self):
        self.create({"person_id": "person-a"})
        self.assertEqual(self.modal.created[0]["kwargs"]["encrypted_ports"], [8001])
        self.assertEqual(self.modal.created[0]["kwargs"].get("unencrypted_ports", []), [])

    def test_the_desktop_runs_no_live_view(self):
        for banned in ("x11vnc", "websockify", "novnc", "6080", "-nopw"):
            self.assertNotIn(banned, app.START_SH)
            self.assertNotIn(banned, app.CONTROL_PY)


class PersonStorage(Service):
    def test_a_sandbox_mounts_only_that_persons_volume(self):
        self.create({"person_id": "person-a"})
        volumes = self.modal.created[0]["kwargs"]["volumes"]
        self.assertEqual(list(volumes), ["/profile"])
        self.assertEqual(volumes["/profile"].name, app.profile_volume_name("person-a", SERVICE_ENV["MANO_PROFILE_KEY"]))
        self.assertTrue(volumes["/profile"].created)
        self.assertNotIn("/profiles", app.START_SH)

    def test_a_missing_or_empty_person_is_refused(self):
        for body in ({}, {"person_id": ""}, {"person_id": "   "}, {"person_id": 7}, {"person_id": None}, {"profile": "person-a"}, ["person-a"]):
            status, _ = self.create(body)
            self.assertEqual(status, 400, body)
        self.assertEqual(self.modal.created, [])

    def test_a_body_that_is_not_json_is_refused(self):
        status, _ = self.create(ValueError("not json"))
        self.assertEqual(status, 400)
        self.assertEqual(self.modal.created, [])


class ProfileNames(unittest.TestCase):
    KEY = "synthetic-profile-key"

    def test_ids_that_used_to_collapse_stay_distinct(self):
        for left, right in (("person:a", "persona"), ("../", "default"), ("../", "."), ("a/b", "ab"), ("A", "a")):
            self.assertNotEqual(app.profile_volume_name(left, self.KEY), app.profile_volume_name(right, self.KEY), (left, right))

    def test_distinct_ids_give_distinct_names(self):
        names = {app.profile_volume_name("person-%d" % i, self.KEY) for i in range(500)}
        self.assertEqual(len(names), 500)

    def test_the_name_is_stable_and_keyed(self):
        self.assertEqual(app.profile_volume_name("person-a", self.KEY), app.profile_volume_name("person-a", self.KEY))
        self.assertNotEqual(app.profile_volume_name("person-a", self.KEY), app.profile_volume_name("person-a", "other-key"))

    def test_the_name_is_a_valid_modal_volume_name_without_the_id(self):
        name = app.profile_volume_name("person:a/../b c", self.KEY)
        self.assertRegex(name, r"^[a-z0-9-]{1,63}$")
        self.assertNotIn("person", name.removeprefix("mano-profile-"))

    def test_an_empty_id_or_key_has_no_name(self):
        for person, key in (("", self.KEY), ("person-a", "")):
            with self.assertRaises(ValueError):
                app.profile_volume_name(person, key)


class PortalOnly(Service):
    def test_the_sandbox_reaches_only_the_portal_host(self):
        self.create({"person_id": "person-a", "portal": "https://elsewhere.test"})
        kwargs = self.modal.created[0]["kwargs"]
        self.assertEqual(kwargs["outbound_domain_allowlist"], ["portal.test"])
        self.assertEqual(kwargs["env"]["MANO_PORTAL_ORIGIN"], "https://portal.test")

    def test_chromium_blocks_every_origin_but_the_portal(self):
        self.create({"person_id": "person-a"})
        policy = json.loads(self.modal.created[0]["kwargs"]["env"]["MANO_CHROMIUM_POLICY"])
        self.assertEqual(policy["URLBlocklist"], ["*"])
        self.assertEqual(policy["URLAllowlist"], ["https://.portal.test"])
        self.assertEqual(policy["DeveloperToolsAvailability"], 2)

    def test_no_portal_origin_means_no_desktops(self):
        for value in ("", "portal.test", "http://portal.test", "https://", "https://portal.test/apply", "https://user@portal.test", "https://portal.test?x=1"):
            with mock.patch.dict(os.environ, {"MANO_PORTAL_ORIGIN": value}):
                status, _ = self.create({"person_id": "person-a"})
                self.assertEqual(status, 503, value)
        self.assertEqual(self.modal.created, [])

    def test_portal_origins_normalize(self):
        portal = app.parse_portal_origin("https://Portal.Test:8443/")
        self.assertEqual((portal.origin, portal.host), ("https://portal.test:8443", "portal.test"))
        self.assertEqual(app.chromium_policy(portal)["URLAllowlist"], ["https://.portal.test:8443"])
        self.assertEqual(app.parse_portal_origin("https://portal.test:443").origin, "https://portal.test")


class Lifecycle(Service):
    def test_a_desktop_that_never_gets_ready_is_terminated(self):
        self.ready_error = TimeoutError("chromium window never appeared")
        status, _ = self.create({"person_id": "person-a"})
        self.assertEqual(status, 503)
        self.assertEqual([sid for sid, _ in self.modal.terminated], ["sb-0"])
        self.assertEqual(self.sessions.data, {})

    def test_delete_keeps_the_record_until_termination_is_confirmed(self):
        _, body = self.create({"person_id": "person-a"})
        self.modal.terminate_failures = 1
        status, _ = self.delete(body["id"], SERVICE_AUTH)
        self.assertEqual(status, 502)
        self.assertIn(body["id"], self.sessions.data)
        status, _ = self.delete(body["id"], SERVICE_AUTH)
        self.assertEqual(status, 200)
        self.assertEqual(self.modal.terminated, [("sb-0", True)])
        self.assertEqual(self.sessions.data, {})

    def test_deleting_a_sandbox_that_is_already_gone_succeeds(self):
        _, body = self.create({"person_id": "person-a"})
        self.modal.gone.add("sb-0")
        status, _ = self.delete(body["id"], SERVICE_AUTH)
        self.assertEqual(status, 200)
        self.assertEqual(self.sessions.data, {})

    def test_delete_needs_the_service_token(self):
        _, body = self.create({"person_id": "person-a"})
        status, _ = self.delete(body["id"], {})
        self.assertEqual(status, 401)
        self.assertIn(body["id"], self.sessions.data)

    def test_deleting_an_unknown_session_is_not_found(self):
        status, _ = self.delete("nope", SERVICE_AUTH)
        self.assertEqual(status, 404)


SECRET = "synthetic-session-secret"


class ControlServer(unittest.TestCase):
    """The control server inside the sandbox, run here on a loopback port."""

    def setUp(self):
        tmp = tempfile.mkdtemp()
        script = Path(tmp) / "control.py"
        script.write_text(app.CONTROL_PY)
        env = {"MANO_SESSION_SECRET_SHA256": hashlib.sha256(SECRET.encode()).hexdigest(), "MANO_PORTAL_ORIGIN": "https://portal.test"}
        with mock.patch.dict(os.environ, env):
            spec = importlib.util.spec_from_file_location("mano_control_under_test", script)
            self.control = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(self.control)
        self.ran = []
        self.control.run = lambda *args: self.ran.append(args)
        self.control.screenshot_bytes = lambda: b"\x89PNG"
        self.control.UPLOADS = str(Path(tmp) / "uploads")
        self.server = self.control.ThreadingHTTPServer(("127.0.0.1", 0), self.control.Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.shutdown)
        self.base = "http://127.0.0.1:%d" % self.server.server_address[1]

    def call(self, method, path, body=None, secret=None):
        headers = {"content-type": "application/json"}
        if secret is not None:
            headers["authorization"] = "Bearer " + secret
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=5) as res:
                return res.status
        except urllib.error.HTTPError as err:
            err.close()
            return err.code

    ROUTES = (
        ("GET", "/health", None),
        ("GET", "/screenshot", None),
        ("POST", "/act", {"actions": [{"type": "screenshot"}]}),
        ("POST", "/goto", {"url": "https://portal.test/apply"}),
        ("POST", "/stage", {"name": "a.pdf", "data_base64": "JVBERg=="}),
        ("GET", "/nowhere", None),
    )

    def test_every_route_refuses_a_caller_without_the_session_secret(self):
        for method, path, body in self.ROUTES:
            for secret in (None, "", "wrong", SECRET + "x"):
                self.assertEqual(self.call(method, path, body, secret), 401, (method, path, secret))
        self.assertEqual(self.ran, [])
        self.assertFalse(os.path.exists(self.control.UPLOADS))

    def test_the_session_secret_opens_every_route(self):
        for method, path, body in self.ROUTES[:-1]:
            self.assertEqual(self.call(method, path, body, SECRET), 200, (method, path))
        self.assertEqual(self.call("GET", "/nowhere", None, SECRET), 404)

    def test_goto_refuses_any_origin_but_the_portal(self):
        for url in ("https://elsewhere.test/", "https://portal.test.elsewhere.test/", "http://portal.test/", "file:///profile", "javascript:alert(1)"):
            self.assertEqual(self.call("POST", "/goto", {"url": url}, SECRET), 403, url)
        self.assertEqual(self.ran, [])

    def test_a_server_without_a_secret_refuses_everything(self):
        with mock.patch.dict(os.environ, {"MANO_SESSION_SECRET_SHA256": ""}):
            self.assertFalse(self.control.authorized_header("Bearer ", ""))
            self.assertFalse(self.control.authorized_header("Bearer " + SECRET, ""))


class Shape(unittest.TestCase):
    def test_the_service_secret_holds_every_key_it_needs(self):
        source = Path(app.__file__).read_text()
        match = re.search(r"required_keys=\[([^\]]*)\]", source)
        self.assertIsNotNone(match)
        keys = set(re.findall(r'"([A-Z_]+)"', match.group(1)))
        self.assertEqual(keys, {"MANO_COMPUTER_TOKEN", "MANO_PROFILE_KEY", "MANO_PORTAL_ORIGIN"})


if __name__ == "__main__":
    unittest.main()
