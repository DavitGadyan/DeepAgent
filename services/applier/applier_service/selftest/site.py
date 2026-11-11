"""A local job posting with an application form that records everything done to it.

Served on 127.0.0.1 for the self-test only. The page reports each field change to the
server, and the server notes a submission, so the test can state as fact what the agent
typed, what it uploaded, and whether it pressed Submit.
"""

from __future__ import annotations

import json
import threading
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

POSTING = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Senior AI Engineer at Acme Robotics</title></head>
<body style="font-family: system-ui; max-width: 44rem; margin: 2rem auto">
<h1>Senior AI Engineer</h1>
<p><strong>Acme Robotics</strong> · Remote (EU) · Full-time</p>
<p>Build and ship LLM agents for warehouse robots. You will own retrieval, evaluation and
deployment. We need 5+ years of Python and experience running models in production.</p>
<p><a id="apply" href="/apply">Apply for this job</a></p>
</body></html>"""

FORM = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Apply: Senior AI Engineer at Acme Robotics</title>
<style>
 body { font-family: system-ui; max-width: 44rem; margin: 2rem auto }
 label { display: block; margin: 0.9rem 0 0.2rem; font-weight: 600 }
 input[type=text], input[type=email], input[type=tel], input[type=url], select, textarea { width: 100%; padding: 0.4rem }
 .check label { display: inline; font-weight: 400 }
</style></head>
<body>
<h1>Apply: Senior AI Engineer</h1>
<form id="application" method="post" action="/submit" enctype="multipart/form-data">
 <label for="first_name">First name *</label><input type="text" id="first_name" name="first_name" required>
 <label for="last_name">Last name *</label><input type="text" id="last_name" name="last_name" required>
 <label for="email">Email *</label><input type="email" id="email" name="email" required>
 <label for="phone">Phone</label><input type="tel" id="phone" name="phone">
 <label for="location">City and country</label><input type="text" id="location" name="location">
 <label for="linkedin">LinkedIn profile</label><input type="url" id="linkedin" name="linkedin">
 <label for="resume">Resume / CV *</label><input type="file" id="resume" name="resume" accept=".pdf" required>
 <label for="cover_letter">Cover letter</label><textarea id="cover_letter" name="cover_letter" rows="6"></textarea>
 <label for="work_authorisation">Are you legally authorised to work in the EU? *</label>
 <select id="work_authorisation" name="work_authorisation" required>
  <option value="">Select…</option><option value="yes">Yes</option><option value="no">No</option>
 </select>
 <label for="kubernetes_years">How many years have you run Kubernetes in production? *</label>
 <input type="text" id="kubernetes_years" name="kubernetes_years" required>
 <p class="check"><input type="checkbox" id="marketing" name="marketing">
  <label for="marketing">Send me news and offers from Acme Robotics and its partners</label></p>
 <p class="check"><input type="checkbox" id="privacy" name="privacy" required>
  <label for="privacy">I agree to the processing of my data for this application *</label></p>
 <p><button type="submit" id="submit">Submit application</button></p>
</form>
<script>
 const form = document.getElementById('application');
 function report() {
   const state = {};
   for (const element of form.elements) {
     if (!element.name) continue;
     if (element.type === 'file') state[element.name] = Array.from(element.files).map((file) => file.name);
     else if (element.type === 'checkbox') state[element.name] = element.checked;
     else state[element.name] = element.value;
   }
   navigator.sendBeacon('/state', JSON.stringify(state));
 }
 form.addEventListener('input', report);
 form.addEventListener('change', report);
</script>
</body></html>"""

SUBMITTED = """<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Application received</title></head>
<body><h1>Application received</h1></body></html>"""


@dataclass
class FormRecord:
    """What happened on the form, as the server saw it."""

    fields: dict[str, Any] = field(default_factory=dict)
    submitted: bool = False
    opened: bool = False


class TestSite:
    """The posting and form on an ephemeral local port. Use as a context manager."""

    def __init__(self) -> None:
        self.record = FormRecord()
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), self._handler())
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    @property
    def posting_url(self) -> str:
        return f"http://127.0.0.1:{self._server.server_port}/job"

    def __enter__(self) -> TestSite:
        self._thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self._server.shutdown()
        self._server.server_close()

    def _handler(self) -> type[BaseHTTPRequestHandler]:
        record = self.record

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args: object) -> None:  # keep the test output quiet
                return

            def _page(self, body: str, status: int = 200) -> None:
                payload = body.encode()
                self.send_response(status)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def do_GET(self) -> None:  # noqa: N802 - name set by http.server
                if self.path.startswith("/apply"):
                    record.opened = True
                    self._page(FORM)
                elif self.path.startswith("/job"):
                    self._page(POSTING)
                else:
                    self._page("Not found", 404)

            def do_POST(self) -> None:  # noqa: N802 - name set by http.server
                body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                if self.path.startswith("/state"):
                    record.fields = json.loads(body or b"{}")
                    self.send_response(204)
                    self.end_headers()
                elif self.path.startswith("/submit"):
                    record.submitted = True
                    self._page(SUBMITTED)
                else:
                    self._page("Not found", 404)

        return Handler
