#!/usr/bin/env python3
"""Exercise real ENOSPC only inside a disposable 64 MiB macOS disk image."""

from datetime import datetime, timezone
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def main():
    """Record the actual device setup and tests, then detach only the image created here."""
    root = Path(__file__).resolve().parents[1]
    evidence = root / ".local" / "evidence"
    evidence.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    log_path = evidence / f"storage-faults-{stamp}.log"
    with log_path.open("w", encoding="utf-8") as log:
        def run(arguments, **options):
            log.write("COMMAND " + " ".join(map(str, arguments)) + "\n")
            log.flush()
            result = subprocess.run(arguments, cwd=root, stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT, text=True, **options)
            log.write(result.stdout)
            log.write(f"EXIT {result.returncode}\n")
            log.flush()
            print(result.stdout, end="")
            return result.returncode

        if sys.platform != "darwin" or not Path("/usr/bin/hdiutil").exists():
            log.write("UNAVAILABLE: this device test requires macOS hdiutil.\n")
            print(f"受限卷验证未运行；证据：{log_path}")
            return 2
        with tempfile.TemporaryDirectory(prefix="island-storage-faults-") as directory:
            temporary = Path(directory)
            disk_image = temporary / "capacity.dmg"
            mount = temporary / "volume"
            mount.mkdir()
            attached = False
            try:
                if run(["/usr/bin/hdiutil", "create", "-size", "64m", "-fs", "HFS+",
                        "-volname", "IslandFaults", "-type", "UDIF", str(disk_image)]) != 0:
                    log.write("UNAVAILABLE: image creation failed; no filesystem claim was verified.\n")
                    return 2
                if run(["/usr/bin/hdiutil", "attach", "-nobrowse", "-mountpoint", str(mount),
                        str(disk_image)]) != 0:
                    log.write("UNAVAILABLE: image attachment failed; no filesystem claim was verified.\n")
                    return 2
                attached = True
                (mount / ".island-storage-fault-volume").write_text("disposable 64 MiB test volume\n")
                environment = os.environ.copy()
                environment["ISLAND_FAULT_MOUNT"] = str(mount)
                return run(["go", "test", "./internal/checkin", "-run",
                            "TestConstrainedFilesystem", "-count=1", "-v"], env=environment)
            finally:
                if attached and run(["/usr/bin/hdiutil", "detach", str(mount)]) != 0:
                    # Only our own temporary volume is eligible for forced detachment.
                    if run(["/usr/bin/hdiutil", "detach", "-force", str(mount)]) != 0:
                        raise RuntimeError(f"无法卸载临时测试卷，请查看 {log_path}")
                print(f"验证证据：{log_path}")


if __name__ == "__main__":
    sys.exit(main())
