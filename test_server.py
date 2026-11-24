"""Tests for the web server: routes, limits and the safety measures listed in app.py."""
import http.client
import json
import socket
import threading
import unittest

import app


class ServerTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = app.make_server("127.0.0.1", 0)          # port 0 = any free port
        cls.port = cls.server.server_address[1]
        cls.host = f"127.0.0.1:{cls.port}"
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def request(self, method, path, body=None, headers=None, host=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        hdrs = {"Host": host or self.host, **(headers or {})}
        conn.request(method, path, body=body, headers=hdrs)
        resp = conn.getresponse()
        data = resp.read()
        conn.close()
        return resp, data

    def post_json(self, path, payload, **kw):
        return self.request("POST", path, json.dumps(payload).encode(),
                            {"Content-Type": "application/json", **kw.pop("headers", {})}, **kw)


class TestRoutes(ServerTestCase):
    def test_page_and_static_files(self):
        for path, kind in [("/", "text/html"), ("/static/style.css", "text/css"),
                           ("/static/app.js", "text/javascript"), ("/static/theme.js", "text/javascript"),
                           ("/static/hero-fx.css", "text/css"), ("/static/hero-fx.js", "text/javascript"),
                           ("/static/logo.svg", "image/svg+xml")]:
            resp, body = self.request("GET", path)
            self.assertEqual(resp.status, 200, path)
            self.assertTrue(resp.getheader("Content-Type").startswith(kind), path)
            self.assertTrue(body)

    def test_scan_redacts_and_hides_original(self):
        resp, body = self.post_json("/scan", {"text": "mail ana@mail.com now"})
        data = json.loads(body)
        self.assertEqual(resp.status, 200)
        self.assertEqual(data["redacted_text"], "mail [EMAIL_01] now")
        self.assertNotIn("original_text", data)
        self.assertEqual((data["pii_count"], data["text_count"]), (1, 2))
        self.assertTrue(all(t["steps"] == [] for t in data["tokens"]))      # traces are fetched lazily

    def test_key_value_pairs_are_redacted(self):
        _, body = self.post_json("/scan", {"text": "API_KEY=ghp_aB3dE5fG7hI9jK1lM3nO5pQ7rS9\nmail=ana@mail.com"})
        self.assertEqual(json.loads(body)["redacted_text"], "API_KEY=[API_KEY_01]\nmail=[EMAIL_02]")

    def test_trace_endpoint(self):
        _, body = self.post_json("/trace", {"token": "a@b.co", "dfa": "email"})
        data = json.loads(body)
        self.assertTrue(data["accepted"])
        self.assertEqual(len(data["steps"]), 6)
        resp, _ = self.post_json("/trace", {"token": "x", "dfa": "nope"})
        self.assertEqual(resp.status, 400)
        resp, _ = self.post_json("/trace", {"token": "x" * 201})
        self.assertEqual(resp.status, 400)

    def test_redact_file(self):
        resp, body = self.request("POST", "/redact-file?name=../../etc/My%20Report.CSV", b"id,mail\n1,ana@mail.com\n",
                                  {"Content-Type": "application/octet-stream"})
        self.assertEqual(resp.status, 200)
        self.assertEqual(body, b"id,mail\n1,[EMAIL_01]\n")
        self.assertEqual(resp.getheader("Content-Disposition"), 'attachment; filename="My Report.redacted.csv"')
        self.assertEqual(resp.getheader("X-PII-Count"), "1")
        resp, _ = self.request("POST", "/redact-file?name=evil.exe", b"x", {})
        self.assertEqual(resp.status, 400)

    def test_unknown_paths_and_traversal(self):
        for path in ["/nope", "/static/../app.py", "/static/%2e%2e/app.py", "/app.py", "/static/"]:
            resp, _ = self.request("GET", path)
            self.assertEqual(resp.status, 404, path)


class TestSafety(ServerTestCase):
    def test_security_headers(self):
        resp, _ = self.request("GET", "/")
        csp = resp.getheader("Content-Security-Policy")
        self.assertIn("script-src 'self'", csp)
        self.assertNotIn("unsafe-inline", csp)
        self.assertEqual(resp.getheader("X-Content-Type-Options"), "nosniff")
        self.assertEqual(resp.getheader("X-Frame-Options"), "DENY")
        self.assertEqual(resp.getheader("Referrer-Policy"), "no-referrer")

    def test_page_has_no_inline_script_or_style(self):
        _, body = self.request("GET", "/")
        html = body.decode()
        self.assertNotIn("style=", html)
        import re
        for tag in re.findall(r"<script[^>]*>", html):
            self.assertIn("src=", tag)
        self.assertNotIn("<style", html)

    def test_foreign_host_is_rejected(self):
        resp, _ = self.request("GET", "/api/dfas", host="evil.example")
        self.assertEqual(resp.status, 403)

    def test_cross_origin_post_is_rejected(self):
        resp, _ = self.post_json("/scan", {"text": "a"}, headers={"Origin": "http://evil.example"})
        self.assertEqual(resp.status, 403)
        resp, _ = self.post_json("/scan", {"text": "a"}, headers={"Origin": f"http://{self.host}"})
        self.assertEqual(resp.status, 200)

    def test_json_endpoints_require_json(self):
        resp, _ = self.request("POST", "/scan", b'{"text":"a"}', {"Content-Type": "text/plain"})
        self.assertEqual(resp.status, 415)
        for bad in [b"not json", b"[1,2]", b'{"text": 5}']:
            resp, _ = self.request("POST", "/scan", bad, {"Content-Type": "application/json"})
            self.assertEqual(resp.status, 400, bad)

    def test_size_limits(self):
        # Declared size is checked before any body is read, so no huge upload is needed.
        head = f"POST /scan HTTP/1.1\r\nHost: {self.host}\r\nContent-Type: application/json\r\n"
        reply = self._raw((head + f"Content-Length: {app.MAX_SCAN_BYTES + 1}\r\n\r\n").encode())
        self.assertIn(b" 413 ", reply)
        head = f"POST /redact-file?name=a.txt HTTP/1.1\r\nHost: {self.host}\r\n"
        reply = self._raw((head + f"Content-Length: {app.MAX_UPLOAD_BYTES + 1}\r\n\r\n").encode())
        self.assertIn(b" 413 ", reply)

    def _raw(self, request: bytes) -> bytes:
        with socket.create_connection(("127.0.0.1", self.port), timeout=3) as s:
            s.sendall(request)
            return s.recv(4096)

    def test_bad_content_length_does_not_hang_or_crash(self):
        head = f"POST /scan HTTP/1.1\r\nHost: {self.host}\r\nContent-Type: application/json\r\n"
        self.assertIn(b" 400 ", self._raw((head + "Content-Length: -1\r\n\r\n").encode()))
        self.assertIn(b" 400 ", self._raw((head + "Content-Length: abc\r\n\r\n").encode()))
        self.assertIn(b" 411 ", self._raw((head + "\r\n").encode()))

    def test_stalled_client_does_not_block_others(self):
        stalled = socket.create_connection(("127.0.0.1", self.port))
        stalled.sendall(f"POST /scan HTTP/1.1\r\nHost: {self.host}\r\nContent-Length: 100\r\n\r\nabc".encode())
        try:
            resp, _ = self.request("GET", "/api/dfas")
            self.assertEqual(resp.status, 200)
        finally:
            stalled.close()

    def test_large_scan_response_stays_small(self):
        text = "john.doe@email.com sk-proj-abc123xyz789def456 +639123456789 hello world\n" * 10000   # ~700 KB
        resp, body = self.post_json("/scan", {"text": text})
        self.assertEqual(resp.status, 200)
        self.assertLess(len(body), 1024 * 1024)             # was ~85 MB before steps went lazy
        data = json.loads(body)
        self.assertEqual(data["pii_count"], 30000)              # counts still cover everything
        self.assertTrue(data["tokens_truncated"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
