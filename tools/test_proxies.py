"""Check that a file somebody is watching never waits behind warming work."""
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from pklipper import media

BUILD_SECONDS = 0.4
started = []


def slow_build(source, target, background=False):
    """Stand in for ffmpeg: record the order, take a moment, write the file."""
    started.append((time.time(), Path(source).name))
    time.sleep(BUILD_SECONDS)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(b"proxy")
    return True, ""


def main():
    media.build_proxy = slow_build
    root = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp") / "pklipper-proxy-test"
    pool = media.ProxyPool(root / "src", root / "cache", workers=2)

    waiting = [f"warm{number}.MOV" for number in range(12)]
    for name in waiting:
        pool.request(name, priority=2)
    watched = "watched.MOV"
    began = time.time()
    pool.request(watched, priority=0)
    while pool.state(watched) not in {"ready", "failed"} and time.time() - began < 20:
        time.sleep(0.02)
    took = time.time() - began

    queue_time = BUILD_SECONDS * len(waiting) / 2
    print(f"  watched file ready in {took:.2f}s "
          f"(waiting through the queue would be ~{queue_time:.1f}s)")
    if took > BUILD_SECONDS * 2.5:
        sys.exit("FAIL: the watched file waited for background work")

    pool.request(watched, priority=0)
    time.sleep(BUILD_SECONDS * 1.5)
    builds = [name for _, name in started if name == watched]
    if len(builds) != 1:
        sys.exit(f"FAIL: {watched} was built {len(builds)} times, expected once")
    print("  a file already queued is promoted, and still built only once")


if __name__ == "__main__":
    main()
