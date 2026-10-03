"""Start the viewer for a library folder and open it like an app window."""
import argparse
import os
import shutil
import socket
import subprocess
import sys
import webbrowser
from pathlib import Path

from .server import FILTERED, UNFILTERED, serve

APP_WINDOW_BROWSERS = ["chromium", "brave", "google-chrome-stable", "google-chrome",
                       "vivaldi-stable", "microsoft-edge-stable"]
DEFAULT_PORT = 8723


def config_file():
    """Where the last library used is remembered."""
    base = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    return base / "clipper" / "library"


def remember(root):
    """Store `root` as the library a bare `clipper` opens."""
    path = config_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(str(root) + "\n")


def resolve_library(argument):
    """The library root to open, from the argument or from what was last used."""
    if argument:
        root = Path(argument).expanduser().resolve()
    else:
        path = config_file()
        if not path.is_file():
            sys.exit("no library remembered yet — run: clipper /path/to/your/photos")
        root = Path(path.read_text().strip())
    if not (root / UNFILTERED).is_dir():
        sys.exit(f"{root} has no {UNFILTERED}/ folder — point clipper at the folder "
                 f"that holds your originals in {UNFILTERED}/")
    (root / FILTERED).mkdir(exist_ok=True)
    return root


def free_port(preferred):
    """`preferred` when it is free, otherwise a port the system picks.

    The probe reuses addresses exactly as the server does, so a port still in
    TIME_WAIT from the previous run counts as free and the address stays stable
    across restarts.
    """
    with socket.socket() as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind(("127.0.0.1", preferred))
            return preferred
        except OSError:
            pass
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def open_window(url):
    """Open `url` in a chromeless app window, falling back to the usual browser."""
    for browser in APP_WINDOW_BROWSERS:
        found = shutil.which(browser)
        if found:
            subprocess.Popen([found, f"--app={url}"],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return
    webbrowser.open(url)


def parse_args():
    parser = argparse.ArgumentParser(prog="clipper", description=__doc__)
    parser.add_argument("library", nargs="?",
                        help=f"folder holding {UNFILTERED}/ (default: the last one used)")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--no-window", action="store_true",
                        help="only print the address, open nothing")
    return parser.parse_args()


def main():
    args = parse_args()
    if shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None:
        sys.exit("clipper needs ffmpeg and ffprobe on the PATH\n"
                 "  Arch:    sudo pacman -S ffmpeg\n"
                 "  macOS:   brew install ffmpeg\n"
                 "  Windows: winget install Gyan.FFmpeg")
    root = resolve_library(args.library)
    remember(root)
    port = free_port(args.port)
    server = serve(root, args.host, port)
    url = f"http://{args.host}:{port}/"
    print(f"clipper · {root} · {url}", flush=True)
    if not args.no_window:
        open_window(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
