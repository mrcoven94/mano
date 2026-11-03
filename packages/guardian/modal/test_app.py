# Run: pip install "modal==1.6.2" "fastapi==0.162.0" "httpx==0.28.1" "uvicorn==0.54.0"
#      python -m unittest discover -s packages/guardian/modal
import contextlib
import io
import json
import socket
import sys
import threading
import time
import unittest
import urllib.request
import warnings
from pathlib import Path
from types import SimpleNamespace

warnings.filterwarnings("ignore")
sys.path.insert(0, str(Path(__file__).parent))
import app  # noqa: E402

PASS = '{"review":"Nothing is wrong.","verdict":"pass","problems":[]}'
BLOCK = '{"review":"Wrong recipient.","verdict":"block","problems":["The recipient is not the one the person approved."]}'


class CollectAllEngine:
    """Copies vLLM's offline LLM: every caller steps one shared engine and
    returns every request that finished during its call, sorted by id."""

    def __init__(self):
        self._lock = threading.Lock()
        self._next_id = 0
        self._pending = []

    def chat(self, messages, sampling_params, use_tqdm):
        unsafe = "outsider@example.net" in messages[-1]["content"]
        with self._lock:
            request_id = self._next_id
            self._next_id += 1
            self._pending.append((request_id, BLOCK if unsafe else PASS))
        # The unsafe check is shorter, so it steps the engine first.
        time.sleep(0.05 if unsafe else 0.2)
        with self._lock:
            finished, self._pending = self._pending, []
        return [
            SimpleNamespace(
                request_id=str(rid),
                outputs=[SimpleNamespace(text=text, finish_reason="stop")],
            )
            for rid, text in sorted(finished)
        ]


def check_body(recipient):
    return {
        "action": {
            "type": "send",
            "recipient": recipient,
            "purpose": "SNAP renewal",
            "payload": {"claims": ["Dana Whitfield renewed her SNAP case."]},
        },
        "sources": [],
        "consents": [{"recipient": "caseworker@agency.example", "purpose": "SNAP renewal"}],
        "origin": "person",
    }


class OverlappingChecks(unittest.TestCase):
    def test_each_check_gets_its_own_verdict(self):
        engine = CollectAllEngine()
        engine_lock = threading.Lock()
        results = {}

        def run(name, recipient, delay):
            time.sleep(delay)
            try:
                results[name] = app.ask_model(engine, engine_lock, check_body(recipient), None)["verdict"]
            except RuntimeError as error:
                results[name] = f"error: {error}"

        threads = [
            threading.Thread(target=run, args=("safe", "caseworker@agency.example", 0.0)),
            threading.Thread(target=run, args=("unsafe", "outsider@example.net", 0.02)),
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(results, {"safe": "pass", "unsafe": "block"})


class Verdicts(unittest.TestCase):
    def test_the_review_never_leaves_the_server(self):
        text = '{"review":"The payload sends to outsider@example.net.","verdict":"block","problems":["Wrong address."]}'
        self.assertEqual(
            app.parse_verdict(text), {"verdict": "block", "problems": ["Wrong address."]}
        )

    def test_a_refused_answer_never_repeats_its_text_in_the_error(self):
        for text in (
            '{"review":"x","verdict":"Maria Synthetic, 12 Example Lane","problems":[]}',
            '{"review":"x","Maria Synthetic":1,"Maria Synthetic":2}',
        ):
            with self.assertRaises(ValueError) as caught:
                app.parse_verdict(text)
            self.assertNotIn("Maria", str(caught.exception))


class StrictAnswers(unittest.TestCase):
    def assert_refused(self, text):
        with self.assertRaises(ValueError):
            app.parse_verdict(text)

    def test_a_null_review_is_refused(self):
        self.assert_refused('{"review":null,"verdict":"pass","problems":[]}')

    def test_a_missing_review_is_refused(self):
        self.assert_refused('{"verdict":"pass","problems":[]}')

    def test_an_overlong_review_is_refused(self):
        self.assert_refused(json.dumps({"review": "x" * 301, "verdict": "pass", "problems": []}))

    def test_extra_keys_and_problem_limits_are_refused(self):
        self.assert_refused('{"review":"ok","verdict":"pass","problems":[],"note":"x"}')
        self.assert_refused(json.dumps({"review": "r", "verdict": "block", "problems": ["a", "b", "c", "d"]}))
        self.assert_refused(json.dumps({"review": "r", "verdict": "block", "problems": ["p" * 241]}))

    def test_an_answer_at_the_limits_is_accepted(self):
        answer = {"review": "r" * 300, "verdict": "block", "problems": ["p" * 240] * 3}
        self.assertEqual(
            app.parse_verdict(json.dumps(answer)),
            {"verdict": "block", "problems": ["p" * 240] * 3},
        )


class FakeEngineHealth:
    def __init__(self):
        self.alive = True
        self.recycled = 0

    def make(self):
        return app.EngineHealth(alive=lambda: self.alive, recycle=self.recycle)

    def recycle(self):
        self.recycled += 1


class DeadEngine(unittest.TestCase):
    def test_a_dead_engine_is_not_ready_and_recycles_once(self):
        engine = FakeEngineHealth()
        health = engine.make()
        self.assertTrue(health.ready())
        engine.alive = False
        self.assertFalse(health.ready())
        self.assertFalse(health.ready())
        self.assertEqual(engine.recycled, 1)

    def test_a_fatal_inference_error_recycles(self):
        engine = FakeEngineHealth()
        health = engine.make()

        def dies():
            engine.alive = False
            raise RuntimeError("EngineCore encountered an issue.")

        with self.assertRaises(RuntimeError):
            health.call(dies)
        self.assertEqual(engine.recycled, 1)

    def test_a_bad_answer_from_a_live_engine_keeps_it(self):
        engine = FakeEngineHealth()
        health = engine.make()

        def bad_answer():
            raise ValueError("bad verdict")

        with self.assertRaises(ValueError):
            health.call(bad_answer)
        self.assertEqual(engine.recycled, 0)


class Route(unittest.TestCase):
    """The one HTTP surface, as Engine calls it."""

    def setUp(self):
        from fastapi.testclient import TestClient

        self.engine = FakeEngineHealth()
        self.asked = []

        def ask(body):
            self.asked.append(body)
            return {"verdict": "pass", "problems": [], **app.server_info()}

        api = app.web_app("token", self.engine.make(), ask)
        self.client = TestClient(api, raise_server_exceptions=False)

    def post(self, body, token="token"):
        return self.client.post("/", json=body, headers={"Authorization": f"Bearer {token}"})

    def test_a_check_returns_the_verdict(self):
        response = self.post(check_body("caseworker@agency.example"))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["verdict"], "pass")
        self.assertEqual(response.json()["model"]["id"], app.MODEL_ID)
        self.assertEqual(self.asked, [check_body("caseworker@agency.example")])

    def test_a_warm_up_says_ready_without_asking_the_model(self):
        response = self.post({"warm": True})
        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.json(), {"warming": True, "ready": True})
        self.assertEqual(self.asked, [])

    def test_a_warm_up_on_a_dead_engine_is_not_ready(self):
        self.engine.alive = False
        self.assertEqual(self.post({"warm": True}).json(), {"warming": True, "ready": False})
        self.assertEqual(self.engine.recycled, 1)

    def test_a_wrong_or_missing_token_is_refused_before_the_model(self):
        self.assertEqual(self.post(check_body("x"), token="nope").status_code, 401)
        response = self.client.post("/", json=check_body("x"))
        self.assertEqual(response.status_code, 401)
        self.assertEqual(self.asked, [])

    def test_a_body_that_is_not_an_object_is_refused(self):
        self.assertEqual(self.post([1, 2]).status_code, 400)
        self.assertEqual(self.asked, [])

    def test_there_is_no_other_route(self):
        for path in ("/docs", "/openapi.json", "/redoc", "/v1/chat/completions"):
            self.assertEqual(self.client.get(path).status_code, 404, path)
        self.assertEqual(self.client.get("/").status_code, 405)


class Served(unittest.TestCase):
    """The route served the way the container serves it, over real HTTP."""

    def test_a_check_over_http_writes_nothing_to_the_logs(self):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        body = check_body("Maria Synthetic, 12 Example Lane")
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            api = app.web_app(
                "token",
                FakeEngineHealth().make(),
                lambda b: {"verdict": "pass", "problems": []},
            )
            server = app.serve_in_background(api, host="127.0.0.1", port=port)
            deadline = time.monotonic() + 10
            while not server.started and time.monotonic() < deadline:
                time.sleep(0.05)
            request = urllib.request.Request(
                f"http://127.0.0.1:{port}/",
                data=json.dumps(body).encode(),
                headers={"Authorization": "Bearer token", "Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(request, timeout=10) as response:
                answer = json.load(response)
            server.should_exit = True
        self.assertEqual(answer, {"verdict": "pass", "problems": []})
        self.assertNotIn("Maria", out.getvalue() + err.getvalue())
        self.assertNotIn("POST", out.getvalue() + err.getvalue())


class MinContainers(unittest.TestCase):
    def test_defaults_to_scale_to_zero(self):
        self.assertEqual(app.min_containers_from_env(None), 0)
        self.assertEqual(app.min_containers_from_env(""), 0)
        self.assertEqual(app.min_containers_from_env("1"), 1)

    def test_refuses_other_values(self):
        for bad in ("2", "-1", "yes"):
            with self.assertRaises(RuntimeError):
                app.min_containers_from_env(bad)


if __name__ == "__main__":
    unittest.main()
