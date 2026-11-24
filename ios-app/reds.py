import json
import re
import subprocess
import sys
from pathlib import Path


def tool(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["xcrun", "xcresulttool", *args], capture_output=True, text=True)


def failed_cases(node: dict, bundle: str):
    kind = node.get("nodeType")
    if kind in ("Unit test bundle", "UI test bundle"):
        bundle = node.get("name", bundle)
    if kind == "Test Case":
        if node.get("result") == "Failed":
            yield bundle, node
        return
    for child in node.get("children", []):
        yield from failed_cases(child, bundle)


def messages(node: dict):
    for child in node.get("children", []):
        if child.get("nodeType") == "Failure Message":
            yield child.get("name", "")
        elif child.get("nodeType") != "Test Case":
            yield from messages(child)


def crash_reports(bundle_path: Path, test_id: str, folder: Path) -> list[Path]:
    folder.mkdir(parents=True, exist_ok=True)
    tool("export", "attachments", "--path", str(bundle_path), "--output-path", str(folder),
         "--test-id", test_id, "--filter", "Crash Log*")
    manifest = folder / "manifest.json"
    if not manifest.exists():
        return []
    reports = []
    for test in json.loads(manifest.read_text()):
        for attachment in test.get("attachments", []):
            exported = folder / attachment["exportedFileName"]
            named = folder / attachment.get("originalFileName", exported.name)
            exported.rename(named)
            reports.append(named)
    manifest.unlink()
    return reports


def main(results: Path, crashes: Path) -> None:
    for bundle_path in sorted(results.glob("*.xcresult"), key=lambda path: int(path.stem)):
        read = tool("get", "test-results", "tests", "--path", str(bundle_path))
        if read.returncode != 0:
            print(f"== red tests unread from {bundle_path}: {read.stderr.strip()[:300]}")
            continue
        for plan in json.loads(read.stdout).get("testNodes", []):
            for bundle, case in failed_cases(plan, ""):
                test_id = case.get("nodeIdentifier") or case.get("name", "")
                print(f"== red {bundle}/{test_id}, from {bundle_path}")
                said = list(messages(case))
                for message in said:
                    for line in message.splitlines():
                        print(f"   {line}")
                if not said:
                    print("   the result bundle gives no failure message")
                if any("crashed" in message for message in said):
                    folder = crashes / f"{bundle_path.stem}-{re.sub(r'[^A-Za-z0-9_]+', '-', test_id).strip('-')}"
                    reports = crash_reports(bundle_path, test_id, folder)
                    for report in reports:
                        print(f"   crash report: {report}")
                    if not reports:
                        print("   crash report: none in the result bundle")


main(Path(sys.argv[1]), Path(sys.argv[2]))
