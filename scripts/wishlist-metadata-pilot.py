"""PER-67 loopback demo for a single permitted product page."""

import argparse
import http.client
import ipaddress
import json
import runpy
import socket
import ssl
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import urlsplit


HERE = Path(__file__).resolve().parent
SOURCE = "https://testingurl.dev/scraping/ecommerce/product/1"
MAX_HTML = 1024 * 1024
TIMEOUT = 5
extract = runpy.run_path(str(HERE / "wishlist-metadata-feasibility.py"))["extract"]


def fetch_title_and_image():
    """Connect to a checked address for the fixed source, with its normal TLS identity."""
    target = urlsplit(SOURCE)
    records = socket.getaddrinfo(target.hostname, 443, type=socket.SOCK_STREAM)
    addresses = [ipaddress.ip_address(record[4][0]) for record in records]
    if not addresses or any(not ip.is_global or ip.is_multicast or ip.is_reserved for ip in addresses):
        raise OSError("Source did not resolve to public addresses")

    deadline = time.monotonic() + TIMEOUT
    context = ssl.create_default_context()
    connection = http.client.HTTPSConnection(target.hostname, timeout=TIMEOUT, context=context)
    try:
        with socket.create_connection((str(addresses[0]), 443), timeout=TIMEOUT) as raw:
            with context.wrap_socket(raw, server_hostname=target.hostname) as secure:
                connection.sock = secure
                connection.request("GET", target.path, headers={
                    "Accept": "text/html",
                    "User-Agent": "Stillroom-PER67-Local-Pilot/1.0",
                })
                response = connection.getresponse()
                if response.status != 200 or response.headers.get_content_type() != "text/html":
                    raise OSError("Source returned an unusable response")
                body = bytearray()
                while len(body) <= MAX_HTML:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise TimeoutError("Source took too long")
                    secure.settimeout(remaining)
                    chunk = response.read1(min(16_384, MAX_HTML + 1 - len(body)))
                    if not chunk:
                        break
                    body.extend(chunk)
                if len(body) > MAX_HTML:
                    raise OSError("Source exceeded the HTML size limit")
    finally:
        connection.close()

    data = extract(body.decode("utf-8", errors="replace"), SOURCE)
    title = data.get("title", "").strip()
    image = data.get("image")
    result = {}
    if 0 < len(title) <= 300:
        result["title"] = title
    if image and len(image) <= 4096 and urlsplit(image).netloc == target.netloc:
        result["image"] = image
    return result


class PilotHandler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def allowed_origin(self):
        return (
            self.headers.get("Host") == f"127.0.0.1:{self.server.server_port}"
            and self.headers.get("Origin") in (None, f"http://127.0.0.1:{self.server.server_port}")
            and self.headers.get("Sec-Fetch-Site") in (None, "none", "same-origin")
        )

    def send_body(self, status, body, content_type):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, status, data):
        self.send_body(status, json.dumps(data).encode("utf-8"), "application/json")

    def do_GET(self):
        if not self.allowed_origin():
            return self.send_json(403, {"status": "forbidden"})
        if self.path != "/":
            return self.send_json(404, {"status": "not_found"})
        self.send_body(200, (HERE / "wishlist-metadata-pilot.html").read_bytes(), "text/html; charset=utf-8")

    def do_POST(self):
        if not self.allowed_origin() or self.headers.get("Origin") != f"http://127.0.0.1:{self.server.server_port}":
            return self.send_json(403, {"status": "forbidden"})
        if self.path != "/metadata":
            return self.send_json(404, {"status": "not_found"})
        if self.headers.get_content_type() != "application/json":
            return self.send_json(415, {"status": "invalid_request"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 4096:
                return self.send_json(400, {"status": "invalid_request"})
            self.connection.settimeout(TIMEOUT)
            request = json.loads(self.rfile.read(length))
        except (ValueError, OSError, RecursionError):
            return self.send_json(400, {"status": "invalid_request"})
        if not isinstance(request, dict) or request.keys() != {"url"} or not isinstance(request["url"], str):
            return self.send_json(400, {"status": "invalid_request"})
        if request["url"] != SOURCE:
            return self.send_json(422, {"status": "unsupported_url"})

        if time.monotonic() < self.server.next_lookup:
            return self.send_json(429, {"status": "try_again"})
        self.server.next_lookup = time.monotonic() + 2
        try:
            result = fetch_title_and_image()
        except (OSError, http.client.HTTPException, ValueError, RecursionError):
            return self.send_json(502, {"status": "unavailable"})
        self.send_json(200, {"status": "ok", **result})


def make_server(port):
    server = HTTPServer(("127.0.0.1", port), PilotHandler)
    server.next_lookup = 0
    return server


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=5198)
    with make_server(parser.parse_args().port) as server:
        print(f"Local Wishlist pilot: http://127.0.0.1:{server.server_port}/", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
