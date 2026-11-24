"""
app.py - the web server (Python standard library only).

    GET  /              the website
    GET  /static/...    its CSS, JS and logo (fixed list, nothing else is served)
    GET  /api/dfas      the automata, as nodes/edges for the diagrams
    POST /scan          JSON {"text": "..."}              -> redaction result (counts + token cards)
    POST /trace         JSON {"token": "...", "dfa": id}  -> step-by-step trace of one token
    POST /redact-file   raw file bytes (?name=report.csv) -> redacted file download

Safety measures (each one is covered by test_server.py):
    * listens on 127.0.0.1 only, and rejects any Host header that isn't ours
      (stops DNS-rebinding attacks from other websites)
    * POSTs must come from our own page (Origin check) and /scan, /trace must be JSON
    * strict Content-Length handling and per-route size limits
    * one thread per request plus a socket timeout, so a stalled client can't freeze the server
    * Content-Security-Policy and friends on every response, no inline scripts or styles
    * errors never leak stack traces to the browser
"""
import json
import sys
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from engine import PIIAutomatonEngine

HOST, PORT = "127.0.0.1", 5000
MAX_UPLOAD_BYTES = 5 * 1024 * 1024      # /redact-file
MAX_SCAN_BYTES = 1 * 1024 * 1024        # /scan (the browser also gets a result card per token)
MAX_TRACE_BYTES = 8 * 1024              # /trace
MAX_TRACE_TOKEN = 200                   # characters
MAX_PII_CARDS = 500                    # detail rows returned by /scan (counts are always complete)
MAX_TEXT_CARDS = 100
ALLOWED_EXTENSIONS = {".txt", ".csv", ".tsv", ".log", ".json", ".md"}

BASE = Path(__file__).parent
DASHBOARD = BASE / "dashboard.html"
STATIC_FILES = {                         # URL path -> (file name, content type)
    "/static/style.css": ("style.css", "text/css; charset=utf-8"),
    "/static/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/static/theme.js": ("theme.js", "text/javascript; charset=utf-8"),
    "/static/hero-fx.css": ("hero-fx.css", "text/css; charset=utf-8"),
    "/static/hero-fx.js": ("hero-fx.js", "text/javascript; charset=utf-8"),
    "/static/logo.svg": ("logo.svg", "image/svg+xml"),
}
SECURITY_HEADERS = {
    "Content-Security-Policy": (
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
        "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    ),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cache-Control": "no-store",
}

engine = PIIAutomatonEngine()
AUTOMATA_JSON = json.dumps(engine.describe_automata()).encode("utf-8")
DFA_IDS = {dfa.id for dfa in engine.automata}


def safe_download_name(name: str) -> str:
    """report.csv -> report.redacted.csv (path parts and odd characters removed)."""
    path = Path(Path(name).name)
    stem = "".join(c for c in path.stem if c.isalnum() or c in "-_ ") or "file"
    return f"{stem}.redacted{path.suffix.lower()}"


class RequestHandler(BaseHTTPRequestHandler):
    timeout = 10                  # seconds a client may stall before the connection is dropped
    server_version = "PIIEngine"
    sys_version = ""

    # ------------------------------------------------------------ plumbing
    def log_request(self, code="-", size="-"):
        # Log the path only: the query string contains the uploaded file's name.
        sys.stderr.write(f"{self.command} {urlparse(self.path).path} {code}\n")

    def _send(self, status, body=b"", content_type="application/json", headers=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for key, value in {**SECURITY_HEADERS, **(headers or {})}.items():
            self.send_header(key, value)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass                  # the browser went away; nothing to do

    def _error(self, status, message):
        self._send(status, json.dumps({"error": message}).encode("utf-8"))

    def _guard(self, is_post):
        """Reject requests that did not come from our own page on our own address."""
        allowed = self.server.allowed_hosts
        if self.headers.get("Host", "") not in allowed:
            self._error(403, "Host not allowed.")
            return False
        origin = self.headers.get("Origin")
        if is_post and origin is not None and origin not in {f"http://{h}" for h in allowed}:
            self._error(403, "Cross-origin requests are not allowed.")
            return False
        return True

    def _read_body(self, limit):
        raw = self.headers.get("Content-Length")
        if raw is None:
            self._error(411, "Content-Length header is required.")
        elif not (raw.isascii() and raw.isdigit()):
            self._error(400, "Invalid Content-Length header.")
        elif int(raw) > limit:
            self._error(413, f"Too large (limit {limit // 1024} KB).")
        else:
            return self.rfile.read(int(raw))
        return None

    def _read_json(self, limit):
        if self.headers.get_content_type() != "application/json":
            self._error(415, "Content-Type must be application/json.")
            return None
        body = self._read_body(limit)
        if body is None:
            return None
        try:
            payload = json.loads(body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            payload = None
        if not isinstance(payload, dict):
            self._error(400, "Body must be a JSON object.")
            return None
        return payload

    def _safely(self, handler):
        try:
            handler()
        except TimeoutError:
            self.close_connection = True          # client stalled mid-request
        except Exception:                          # never show a stack trace to the browser
            traceback.print_exc()
            self._error(500, "Internal server error.")

    # ------------------------------------------------------------ routes
    def do_GET(self):
        self._safely(self._get)

    def do_POST(self):
        self._safely(self._post)

    def _get(self):
        if not self._guard(False):
            return
        path = urlparse(self.path).path
        if path == "/":
            self._send(200, DASHBOARD.read_bytes(), "text/html; charset=utf-8")
        elif path == "/api/dfas":
            self._send(200, AUTOMATA_JSON)
        elif path in STATIC_FILES:
            name, content_type = STATIC_FILES[path]
            self._send(200, (BASE / "static" / name).read_bytes(), content_type)
        else:
            self._error(404, "Not found")

    def _post(self):
        if not self._guard(True):
            return
        url = urlparse(self.path)

        if url.path == "/scan":
            payload = self._read_json(MAX_SCAN_BYTES)
            if payload is None:
                return
            text = payload.get("text", "")
            if not isinstance(text, str):
                return self._error(400, "'text' must be a string.")
            result = engine.process_text(text, with_steps=False,
                                         max_pii_detail=MAX_PII_CARDS, max_text_detail=MAX_TEXT_CARDS)
            del result["original_text"]               # the browser already has it
            self._send(200, json.dumps(result).encode("utf-8"))

        elif url.path == "/trace":
            payload = self._read_json(MAX_TRACE_BYTES)
            if payload is None:
                return
            token, dfa_id = payload.get("token"), payload.get("dfa")
            if not isinstance(token, str) or not 0 < len(token) <= MAX_TRACE_TOKEN:
                return self._error(400, f"'token' must be 1-{MAX_TRACE_TOKEN} characters.")
            if dfa_id is not None and dfa_id not in DFA_IDS:
                return self._error(400, "Unknown automaton.")
            self._send(200, json.dumps(engine.trace(token, dfa_id)).encode("utf-8"))

        elif url.path == "/redact-file":
            name = parse_qs(url.query).get("name", ["file.txt"])[0]
            if Path(name).suffix.lower() not in ALLOWED_EXTENSIONS:
                return self._error(400, "Unsupported file type.")
            body = self._read_body(MAX_UPLOAD_BYTES)
            if body is None:
                return
            result = engine.process_text(body.decode("utf-8", errors="replace"), with_steps=False,
                                         max_pii_detail=0, max_text_detail=0)
            self._send(200, result["redacted_text"].encode("utf-8"), "text/plain; charset=utf-8", {
                "Content-Disposition": f'attachment; filename="{safe_download_name(name)}"',
                "X-PII-Count": str(result["pii_count"]),
            })
        else:
            self._error(404, "Not found")


class PIIServer(ThreadingHTTPServer):
    daemon_threads = True
    allowed_hosts = frozenset()


def make_server(host=HOST, port=PORT):
    server = PIIServer((host, port), RequestHandler)
    actual = server.server_address[1]
    server.allowed_hosts = frozenset({f"127.0.0.1:{actual}", f"localhost:{actual}", f"[::1]:{actual}"})
    return server


if __name__ == "__main__":
    server = make_server()
    print(f"Server active at http://{HOST}:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
