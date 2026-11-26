import importlib.util
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import unittest


SPEC = importlib.util.spec_from_file_location(
    "nginx_read_limits", Path(__file__).with_name("fix-itms-nginx-read-limits.py")
)
REPAIR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(REPAIR)

FIXTURE = """limit_req_zone $binary_remote_addr zone=auth_limit:10m rate=30r/m;
limit_req_zone $binary_remote_addr zone=api_limit:10m rate=30r/m;
limit_req_zone $binary_remote_addr zone=general_limit:10m rate=100r/m;
server {
    listen 8080;
    location /api/auth/ {
        limit_req zone=auth_limit burst=20 nodelay;
        limit_req_status 429;
        proxy_pass http://127.0.0.1:3001;
    }
    location /api/ {
        limit_req zone=api_limit burst=10 nodelay;
        limit_req_status 429;
        proxy_pass http://127.0.0.1:3001;
        proxy_read_timeout 90s;
    }
    location /salt-api/ {
        limit_req zone=api_limit burst=10 nodelay;
        proxy_pass http://127.0.0.1:4100;
    }
}
"""


class NginxReadLimitTests(unittest.TestCase):
    def test_deployment_templates_keep_patch_timeout(self):
        root = Path(__file__).resolve().parents[1]
        for name in ("itms.conf", "itms-http.conf"):
            content = (root / "deploy" / "nginx" / name).read_text()
            with self.subTest(template=name):
                self.assertRegex(content, r"location = /api/patch/batch \{\s+proxy_pass http://__BACKEND_UPSTREAM__;\s+proxy_read_timeout 660s;\s+\}")
                self.assertIn("proxy_read_timeout 30s;", content)

    def test_patch_timeout_preserves_parent_proxy_and_limits(self):
        source = REPAIR.render_config(FIXTURE)
        result = REPAIR.render_patch_timeout(source)
        addition = "\n        location = /api/patch/batch {\n            proxy_pass http://127.0.0.1:3001;\n            proxy_read_timeout 660s;\n        }\n"
        self.assertEqual(result.replace(addition, ""), source)
        self.assertIn("proxy_read_timeout 90s;", result)
        self.assertEqual(result.count("proxy_read_timeout 660s;"), 1)
        with self.assertRaises(ValueError):
            REPAIR.render_patch_timeout(result)
        with self.assertRaises(ValueError):
            REPAIR.render_patch_timeout("server { location / { return 404; } }")
        broken = result.replace("            proxy_pass http://127.0.0.1:3001;\n", "")
        self.assertEqual(REPAIR.render_patch_timeout(broken), result)

    @unittest.skipUnless(shutil.which("nginx"), "nginx executable is unavailable")
    def test_patch_post_reaches_upstream(self):
        received = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                received.append((self.path, self.rfile.read(int(self.headers.get("Content-Length", "0")))))
                self.send_response(401)
                self.end_headers()

            def log_message(self, *args):
                pass

        with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as upstream:
            worker = threading.Thread(target=upstream.serve_forever, daemon=True)
            worker.start()
            try:
                with tempfile.TemporaryDirectory(prefix="itms-nginx-http-") as directory:
                    root = Path(directory)
                    (root / "logs").mkdir()
                    with socket.socket() as reservation:
                        reservation.bind(("127.0.0.1", 0))
                        port = reservation.getsockname()[1]
                    fixture = FIXTURE.replace("listen 8080;", f"listen 127.0.0.1:{port};").replace("127.0.0.1:3001", f"127.0.0.1:{upstream.server_port}")
                    config = root / "nginx.conf"
                    config.write_text("error_log stderr;\npid " + str(root / "nginx.pid") + ";\nevents {}\nhttp {\naccess_log off;\n" + REPAIR.render_patch_timeout(REPAIR.render_config(fixture)) + "}\n")
                    command = [shutil.which("nginx"), "-p", directory + "/", "-c", str(config)]
                    try:
                        subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
                        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
                        try:
                            connection.request("POST", "/api/patch/batch", body=b"{}")
                            response = connection.getresponse()
                            self.assertEqual(response.status, 401)
                            response.read()
                        finally:
                            connection.close()
                        self.assertEqual(received, [("/api/patch/batch", b"{}")])
                    finally:
                        subprocess.run(command + ["-s", "quit"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
            finally:
                upstream.shutdown()
                worker.join()

    def test_preserves_every_existing_setting_except_zone_keys(self):
        result = REPAIR.render_config(FIXTURE)
        self.assertEqual(result.count(REPAIR.READ_RULE), 3)
        restored = result.removeprefix(REPAIR.READ_LIMITS + "\n")
        restored = restored.replace("        " + REPAIR.READ_RULE + "\n", "")
        restored = restored.replace("$itms_api_write_key", "$binary_remote_addr")
        for zone, replacement in REPAIR.WRITE_ZONES.items():
            restored = restored.replace("zone=" + replacement, "zone=" + zone)
        self.assertEqual(restored, FIXTURE)

    @unittest.skipUnless(shutil.which("nginx"), "nginx executable is unavailable")
    def test_nginx_accepts_generated_configuration(self):
        with tempfile.TemporaryDirectory(prefix="itms-nginx-test-") as directory:
            root = Path(directory)
            (root / "logs").mkdir()
            config = root / "nginx.conf"
            config.write_text("error_log stderr;\npid " + str(root / "nginx.pid") + ";\nevents {}\nhttp {\naccess_log off;\n" + REPAIR.render_patch_timeout(REPAIR.render_config(FIXTURE)) + "}\n")
            result = subprocess.run([shutil.which("nginx"), "-t", "-p", directory + "/", "-c", str(config)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_read_and_write_keys_are_mutually_exclusive(self):
        self.assertIn('default "";\n    GET $binary_remote_addr;\n    HEAD $binary_remote_addr;', REPAIR.READ_LIMITS)
        self.assertIn('default $binary_remote_addr;\n    GET "";\n    HEAD "";', REPAIR.READ_LIMITS)
        self.assertIn("zone=itms_api_reads:10m rate=10r/s", REPAIR.READ_LIMITS)

    def test_refuses_unknown_duplicate_and_partial_configurations(self):
        for content in (
            FIXTURE.replace("zone=api_limit:", "zone=other_limit:"),
            FIXTURE + "limit_req_zone $binary_remote_addr zone=api_limit:10m rate=30r/m;\n",
            "limit_req_zone $binary_remote_addr zone=auth_limit:10m rate=30r/m;\n"
            "limit_req_zone $binary_remote_addr zone=api_limit:10m rate=30r/m;\n",
            REPAIR.render_config(FIXTURE),
        ):
            with self.subTest(content=content), self.assertRaises(ValueError):
                REPAIR.render_config(content)


if __name__ == "__main__":
    unittest.main()