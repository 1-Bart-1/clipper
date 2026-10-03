"""The viewer's HTTP server: a static page plus a small JSON and media API."""
import json
import mimetypes
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import library, media, record

STATIC_DIR = Path(__file__).parent / "static"
UNFILTERED = "unfiltered"
FILTERED = "filtered"


class Library:
    """A folder holding `unfiltered/` originals and the `filtered/` keepers."""

    def __init__(self, root):
        self.root = root
        self.unfiltered = root / UNFILTERED
        self.filtered = root / FILTERED
        self.cache = root / media.CACHE_DIR
        self.proxies = media.ProxyPool(self.unfiltered, self.cache)
        self.items = []
        self.refresh()

    def refresh(self):
        """Rescan the unfiltered tree, reusing cached capture times."""
        self.items = library.scan(self.unfiltered, self.cache / "index.json")
        return self.items

    def catalogue(self):
        """The whole library as the page needs it, including what is saved."""
        saves = record.saves_by_source(self.root)
        entries = []
        for item in self.items:
            entry = {"relpath": item.relpath, "label": item.label, "kind": item.kind,
                     "day": item.day, "captured": item.captured,
                     "duration": item.duration, "size": item.size, "fps": item.fps,
                     "saves": saves.get(item.label, [])}
            entries.append(entry)
        return {"root": str(self.root), "days": library.days(self.items),
                "items": entries}

    def find(self, relpath):
        """The item at `relpath`, or None when it is not in the library."""
        return next((item for item in self.items if item.relpath == relpath), None)

    def save(self, relpath, name, start=None, end=None):
        """Cut or copy `relpath` into the filtered tree as `name`.

        Returns the path written. Raises ValueError with a message meant for the
        viewer when the request cannot be honoured.
        """
        item = self.find(relpath)
        if item is None:
            raise ValueError(f"{relpath} is not in the library")
        name = name.strip()
        if not name:
            raise ValueError("a name is needed before this can be saved")
        if "/" in name or name.startswith("."):
            raise ValueError(f"name {name!r} may not contain '/' or start with '.'")
        if name in record.names_in_use(self.root):
            raise ValueError(f"name {name!r} is already used")
        source = self.unfiltered / relpath
        day_dir = media.day_directory(self.filtered, item.day)
        if item.kind == "photo":
            target = day_dir / "photos" / (name + source.suffix)
            if target.exists():
                raise ValueError(f"{target.name} already exists")
            if not media.copy_photo(source, target):
                raise ValueError(f"copying {source.name} failed")
            record.append_pick(self.root, relpath, name)
            return target
        if start is None or end is None or end <= start:
            raise ValueError("mark an in point and a later out point first")
        target = day_dir / "clips" / (name + source.suffix.lower())
        if target.exists():
            raise ValueError(f"{target.name} already exists")
        if not media.cut_video(source, start, end, target):
            raise ValueError(f"ffmpeg could not cut {source.name}")
        record.append_cut(self.root, relpath, start, end, name)
        return target


def send_file(handler, path, content_type=None):
    """Send `path` whole, or the requested byte range for a media player."""
    size = path.stat().st_size
    content_type = content_type or mimetypes.guess_type(path.name)[0] \
        or "application/octet-stream"
    requested = handler.headers.get("Range", "")
    match = re.fullmatch(r"bytes=(\d*)-(\d*)", requested.strip())
    start, end = 0, size - 1
    partial = False
    if match and (match.group(1) or match.group(2)):
        if match.group(1):
            start = int(match.group(1))
            if match.group(2):
                end = min(int(match.group(2)), size - 1)
        else:
            start = max(size - int(match.group(2)), 0)
        if start >= size:
            handler.send_response(416)
            handler.send_header("Content-Range", f"bytes */{size}")
            handler.end_headers()
            return
        partial = True
    handler.send_response(206 if partial else 200)
    handler.send_header("Content-Type", content_type)
    handler.send_header("Accept-Ranges", "bytes")
    handler.send_header("Content-Length", str(end - start + 1))
    if partial:
        handler.send_header("Content-Range", f"bytes {start}-{end}/{size}")
    handler.end_headers()
    remaining = end - start + 1
    with path.open("rb") as stream:
        stream.seek(start)
        while remaining > 0:
            chunk = stream.read(min(1 << 20, remaining))
            if not chunk:
                break
            handler.wfile.write(chunk)
            remaining -= len(chunk)


class Handler(BaseHTTPRequestHandler):
    """Routes for the page, its assets and the media API."""

    protocol_version = "HTTP/1.1"
    library = None

    def log_message(self, template, *args):
        """Keep the console to warnings; every request is otherwise noise."""

    def send_json(self, payload, status=200):
        """Send `payload` as JSON."""
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def asset(self, name):
        """Serve a file from the package's static folder."""
        path = (STATIC_DIR / name).resolve()
        if not path.is_file() or STATIC_DIR.resolve() not in path.parents:
            self.send_error(404)
            return
        send_file(self, path)

    def send_image(self, path):
        """Send a derived JPEG, or report that ffmpeg could not make one."""
        if path is None:
            self.send_error(500, "ffmpeg could not render this file")
        else:
            send_file(self, path, "image/jpeg")

    def wanted_item(self, query):
        """The item named by `f=`, answering 404 itself when there is none."""
        relpath = (query.get("f") or [""])[0]
        item = self.library.find(relpath)
        if item is None:
            self.send_error(404, "not in the library")
        return item

    def do_GET(self):
        """Dispatch a GET to the page, an asset, or the API."""
        url = urlparse(self.path)
        query = parse_qs(url.query)
        route = url.path
        if route == "/":
            self.asset("index.html")
        elif route.startswith("/static/"):
            self.asset(route[len("/static/"):])
        elif route == "/api/library":
            self.send_json(self.library.catalogue())
        elif route == "/api/thumb":
            item = self.wanted_item(query)
            if item:
                self.send_image(media.thumbnail(self.library.unfiltered,
                                                self.library.cache, item.relpath))
        elif route == "/api/photo":
            item = self.wanted_item(query)
            if item:
                self.send_image(media.view(self.library.unfiltered,
                                           self.library.cache, item.relpath))
        elif route == "/api/prepare":
            item = self.wanted_item(query)
            if item:
                urgent = (query.get("urgent") or ["1"])[0] != "0"
                state = self.library.proxies.state(item.relpath)
                if state == "absent":
                    state = self.library.proxies.request(item.relpath, urgent)
                self.send_json({"state": state,
                                "error": self.library.proxies.complaint(item.relpath)})
        elif route == "/api/video":
            item = self.wanted_item(query)
            if item:
                proxy = self.library.proxies.target(item.relpath)
                if proxy.is_file():
                    send_file(self, proxy, "video/mp4")
                else:
                    self.send_json({"state": self.library.proxies.state(item.relpath)},
                                   status=202)
        else:
            self.send_error(404)

    def do_POST(self):
        """Handle a save request from the viewer."""
        url = urlparse(self.path)
        length = int(self.headers.get("Content-Length") or 0)
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self.send_json({"error": "malformed request"}, status=400)
            return
        if url.path == "/api/save":
            try:
                target = self.library.save(payload.get("relpath", ""),
                                          payload.get("name", ""),
                                          payload.get("start"), payload.get("end"))
            except ValueError as refusal:
                self.send_json({"error": str(refusal)}, status=400)
                return
            self.send_json({"saved": str(target.relative_to(self.library.root)),
                            "name": payload.get("name", "").strip()})
        elif url.path == "/api/refresh":
            self.library.refresh()
            self.send_json(self.library.catalogue())
        else:
            self.send_error(404)


def serve(root, host, port):
    """Run the viewer for the library at `root` until interrupted."""
    Handler.library = Library(root)
    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    return server
