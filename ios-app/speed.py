#!/usr/bin/env python3
"""The iPhone app's speed harness.

  ./speed.py run --label base --scales 1,10,100 [--device <udid>] [--cold] [--profile 'Time Profiler']
                 [--tests SpeedUITests/testTabSwitches]
  ./speed.py report .build/speed/base [.build/speed/after ...]
  ./speed.py check .build/speed/after [--hz 60|120]
  ./speed.py hot .build/speed/base/x10.trace [--top 25]

`run` builds the app optimized (the Speed build: Release under its own app ID) for the destination
once, then for each scale runs the speed UI tests on the canned home at that scale and reads the
app's own log (`SpeedLog`, Library/Caches/speed.jsonl) out of its container into
.build/speed/<label>/x<scale>.jsonl, with the xcresult beside it. With no --device it runs on this
checkout's simulator; a simulator's numbers say what to try first and prove nothing. --cold reboots
the destination and installs the app afresh before each scale. --profile records beside each scale
an Instruments trace of that template on a phone (x<scale>.trace), or macOS's `sample` of the app's
process on a simulator (x<scale>.sample.txt). It exits nonzero when a test failed or a log came back
empty, after saving everything.

`report` prints, per run, scale, phase and interaction, how many, p50, p95, p99 and max in
milliseconds; per phase the hangs, the late frames and their ms per second in front, the most
footprint sampled after an interaction and the observed callback rate; and per test XCTest's own
metrics from the xcresult. `check` judges a run against the budgets in judge() and exits nonzero,
naming each breach, when one is broken; `run --check` does it at the end. `hot` prints where a
profile's main thread spent its busy time.
"""
import argparse
import json
import os
import pathlib
import re
import signal
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent


def resolved(script, *args):
    result = subprocess.run([str(HERE / script), *args], text=True, stdout=subprocess.PIPE)
    if result.returncode != 0:
        sys.exit(result.returncode)
    return result.stdout.strip()


BUNDLE = resolved("signing.sh", "LIFESTREAM_BUNDLE_PREFIX") + ".phone.speed"
ENV = dict(os.environ, DEVELOPER_DIR=resolved("xcode.sh"))


def sh(*args, check=True, capture=False, env=ENV):
    result = subprocess.run(args, check=False, text=True, env=env,
                            stdout=subprocess.PIPE if capture else None, stderr=subprocess.STDOUT if capture else None)
    if check and result.returncode != 0:
        sys.exit(f"failed ({result.returncode}): {' '.join(args)}\n{result.stdout or ''}")
    return result


def simulator():
    """The one test simulator, made on first use (simulator.sh)."""
    return sh(str(HERE / "simulator.sh"), capture=True).stdout.strip().splitlines()[-1]


class Destination:
    def __init__(self, device):
        self.device = device
        self.udid = device or simulator()
        self.spec = f"id={self.udid}" if device else f"platform=iOS Simulator,id={self.udid}"

    def boot(self):
        if not self.device:
            sh(str(HERE / "simulator.sh"), "boot", self.udid, capture=True)
            sh("xcrun", "simctl", "spawn", self.udid, "log", "config", "--subsystem", "com.apple.dt.xctest",
               "--mode", "level:off", capture=True)

    def cold(self):
        """Caches empty: the app removed and the destination restarted."""
        if self.device:
            sh("xcrun", "devicectl", "device", "uninstall", "app", "--device", self.udid, BUNDLE, check=False, capture=True)
            sh("xcrun", "devicectl", "device", "reboot", "--device", self.udid, check=False, capture=True)
            sh("xcrun", "devicectl", "device", "info", "details", "--device", self.udid, "--timeout", "600", capture=True)
        else:
            sh("xcrun", "simctl", "uninstall", self.udid, BUNDLE, check=False, capture=True)
            sh("xcrun", "simctl", "shutdown", self.udid, check=False, capture=True)
            self.boot()

    def log_path(self):
        container = sh("xcrun", "simctl", "get_app_container", self.udid, BUNDLE, "data", check=False, capture=True)
        if container.returncode != 0:
            return None
        return pathlib.Path(container.stdout.strip()) / "Library/Caches/speed.jsonl"

    def clear_log(self):
        if self.device:
            empty = HERE / ".build/speed/empty.jsonl"
            empty.parent.mkdir(parents=True, exist_ok=True)
            empty.write_text("")
            sh("xcrun", "devicectl", "device", "copy", "to", "--device", self.udid, "--domain-type", "appDataContainer",
               "--domain-identifier", BUNDLE, "--source", str(empty), "--destination", "Library/Caches/speed.jsonl",
               check=False, capture=True)
        elif (path := self.log_path()) and path.exists():
            path.unlink()

    def take_log(self, to):
        if self.device:
            sh("xcrun", "devicectl", "device", "copy", "from", "--device", self.udid, "--domain-type", "appDataContainer",
               "--domain-identifier", BUNDLE, "--source", "Library/Caches/speed.jsonl", "--destination", str(to))
        else:
            path = self.log_path()
            to.write_bytes(path.read_bytes() if path and path.exists() else b"")


def run(args):
    out = HERE / ".build/speed" / args.label
    out.mkdir(parents=True, exist_ok=True)
    destination = Destination(args.device)
    destination.boot()
    derived = HERE / (".build/speed-xcode" if args.device else ".build/speed-xcode-sim")
    common = ["-project", "LifestreamCapture.xcodeproj", "-scheme", "Speed", "-configuration", "Speed",
              "-derivedDataPath", str(derived), "-packageCachePath", str(derived / "PackageCache"),
              "-destination", destination.spec]
    os.chdir(HERE)
    commit = sh("git", "rev-parse", "--short", "HEAD", capture=True).stdout.strip()
    dirty = sh("git", "status", "--porcelain", "--", ".", capture=True).stdout.strip() != ""
    (out / "run.json").write_text(json.dumps({"destination": destination.spec, "device": bool(args.device),
                                              "commit": commit + ("+dirty" if dirty else ""), "cold": args.cold}))
    sh("xcodebuild", "build-for-testing", "-jobs", "4", *common, "ONLY_ACTIVE_ARCH=YES",
       f"LIFESTREAM_COMMIT={commit}", "-allowProvisioningUpdates" if args.device else "COMPILER_INDEX_STORE_ENABLE=NO")
    tests = [f"-only-testing:LifestreamCaptureUITests/{test}" for test in args.tests.split(",")]
    failed = []
    for scale in args.scales.split(","):
        if args.cold:
            destination.cold()
        destination.clear_log()
        bundle = out / f"x{scale}.xcresult"
        sh("rm", "-rf", str(bundle))
        trace = out / (f"x{scale}.trace" if args.device else f"x{scale}.sample.txt")
        recording = None
        if args.profile:
            sh("rm", "-rf", str(trace))
            if args.device:
                recording = subprocess.Popen(["xcrun", "xctrace", "record", "--template", args.profile, "--device", destination.udid,
                                              "--all-processes", "--output", str(trace), "--no-prompt"], env=ENV,
                                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            else:
                recording = subprocess.Popen(["/bin/sh", "-c", "until p=$(pgrep -f 'CoreSimulator/Devices/" + destination.udid + "/.*/Lifestream.app/Lifestream' | tail -1); [ -n \"$p\" ]; "
                                              "do sleep 0.2; done; sleep 8; exec sample $p 600 1 -mayDie -fullPaths -file " + str(trace)],
                                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        result = sh("xcodebuild", "test-without-building", *common, *tests, "-resultBundlePath", str(bundle),
                    "-collect-test-diagnostics", "never", check=False,
                    env=dict(ENV, TEST_RUNNER_SPEED_SCALE=scale))
        if recording:
            recording.send_signal(signal.SIGINT)
            recording.wait()
            if args.device:
                symbols = derived / "Build/Products/Speed-iphoneos/Lifestream.app.dSYM"
                sh("xcrun", "xctrace", "symbolicate", "--input", str(trace), "--dsym", str(symbols), check=False, capture=True)
            print(f"x{scale}: trace {trace}")
        log = out / f"x{scale}.jsonl"
        destination.take_log(log)
        empty = log.stat().st_size == 0
        print(f"x{scale}: tests {'passed' if result.returncode == 0 else 'FAILED'}; log {log}{' EMPTY' if empty else ''}")
        if result.returncode != 0 or empty:
            failed.append(f"x{scale}")
    report(argparse.Namespace(runs=[str(out)]))
    breaches = judge(out, args.hz) if args.check else []
    if failed or breaches:
        sys.exit("; ".join(([f"failed: {', '.join(failed)}"] if failed else []) + ([f"{len(breaches)} budget breaches"] if breaches else [])))


def percentile(sorted_values, q):
    if not sorted_values:
        return None
    index = min(len(sorted_values) - 1, max(0, int(round(q * (len(sorted_values) - 1)))))
    return sorted_values[index]


def summarize(path):
    """Per phase: each interaction's lengths, the late callbacks, hangs and rates, the footprints,
    and the time in front from each process's first logged entry to its last."""
    phases, phase, span = {}, None, None
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        entry = json.loads(line)
        if "launch" in entry:
            name = entry["launch"].rsplit("-x", 1)[0] or "?"
            phase = phases.setdefault(name, {"i": {}, "late": 0, "late_ms": 0.0, "hangs": [], "hz": [], "fp": [],
                                             "after_tabs": None, "spans": []})
            span = [None, None]
            phase["spans"].append(span)
            continue
        if phase is None:
            continue
        if "t" in entry:
            span[0] = entry["t"] if span[0] is None else span[0]
            span[1] = entry["t"]
        if "i" in entry:
            name = entry["i"] + (" (first visit)" if entry.get("first") else "")
            phase["i"].setdefault(name, []).append(entry["ms"])
            phase["fp"].append(entry["fp"])
            if entry["i"] == "Tab switch":
                phase["after_tabs"] = entry["fp"]
        elif "late" in entry:
            phase["late"] += entry["late"]
            phase["late_ms"] += entry["ms"]
            if "hang" in entry:
                phase["hangs"].append(entry["hang"])
        elif "hz" in entry:
            phase["hz"].append(entry["hz"])
    for phase in phases.values():
        phase["seconds"] = sum(last - first for first, last in phase.pop("spans") if first is not None) / 1000
    return phases


METRICS = ("Hitch Time Ratio", "Memory Peak Physical", "CPU Time")
TRANSITIONS = ("NavigationTransition", "Scroll_", "ApplicationFirstFrame")


def xctest_metrics(bundle):
    """XCTest's own metrics of each test in a result bundle: its hitch time ratios, its navigation,
    scroll and launch durations and frame rates, its peak memory and its CPU time."""
    result = sh("xcrun", "xcresulttool", "get", "test-results", "metrics", "--path", str(bundle), check=False, capture=True)
    if result.returncode != 0:
        return []
    rows = []
    for test in json.loads(result.stdout):
        for test_run in test["testRuns"]:
            for metric in test_run["metrics"]:
                shown = metric["displayName"]
                if shown.startswith(METRICS) or (any(t in shown for t in TRANSITIONS) and shown.startswith(("Duration", "Frame Rate"))):
                    values, unit = metric["measurements"], metric["unitOfMeasurement"]
                    value = sum(values) / len(values) if values else 0
                    if unit == "kB":
                        value, unit = value / 1024, "MB"
                    rows.append((test["testIdentifier"].split("/")[-1].removesuffix("()"), shown, value, unit))
    return rows


def meta_of(run):
    return json.loads((run / "run.json").read_text()) if (run / "run.json").exists() else {}


def logs_of(run):
    return sorted(run.glob("x*.jsonl"), key=lambda p: float(p.stem[1:]))


def report(args):
    for run in (pathlib.Path(run) for run in args.runs):
        meta = meta_of(run)
        where = "device" if meta.get("device") else "SIMULATOR (not evidence)"
        print(f"\n## {run.name}: {where}, {meta.get('commit', '?')}{', cold' if meta.get('cold') else ''}\n")
        print("| scale | phase | interaction | n | p50 | p95 | p99 | max |")
        print("|---|---|---|---|---|---|---|---|")
        frames, notes = [], []
        for log in logs_of(run):
            for name, phase in summarize(log).items():
                for interaction, values in sorted(phase["i"].items()):
                    if interaction == "First frame" and name != "launch":
                        continue
                    values = sorted(values)
                    cells = [percentile(values, q) for q in (0.5, 0.95, 0.99)] + [values[-1]]
                    print(f"| {log.stem} | {name} | {interaction} | {len(values)} | " + " | ".join(f"{v:.1f}" for v in cells) + " |")
                hz = sorted(phase["hz"])
                frames.append((log.stem, name, len(phase["hangs"]), phase["late"], phase["late_ms"] / max(phase["seconds"], 0.001),
                               max(phase["fp"]) / 2**20 if phase["fp"] else 0, percentile(hz, 0.5)))
                if name == "tabs" and phase["after_tabs"]:
                    notes.append(f"{log.stem} tabs: {phase['after_tabs'] / 2**20:.0f} MB after the last tab switch")
        print("\nLate ms per second of the phase's time in front, from each process's first logged entry to its last.\n")
        print("| scale | phase | hangs | late frames | late ms/s | footprint sampled after interactions, max MB | Hz observed |")
        print("|---|---|---|---|---|---|---|")
        for scale, name, hangs, late, ratio, peak, hz in frames:
            print(f"| {scale} | {name} | {hangs} | {late} | {ratio:.1f} | {peak:.0f} | {hz if hz is not None else '-'} |")
        if notes:
            print("\n" + "\n".join(notes))
        print("\nXCTest's own metrics (the warm-up iteration dropped).\n")
        print("| scale | test | metric | value |")
        print("|---|---|---|---|")
        for bundle in sorted(run.glob("x*.xcresult"), key=lambda p: float(p.stem[1:])):
            for test, shown, value, unit in xctest_metrics(bundle):
                print(f"| {bundle.stem} | {test} | {shown} | {value:.4g} {unit} |")


FOOTPRINT_CEILING_MB = 700


def judge(run, hz=None):
    """The budgets against each scale of a run: the breaches, each printed, none when it
    holds or when the run is a simulator's. The frame period is 1000 / hz, the Hz observed in the
    log unless `hz` is given."""
    breaches, device = [], meta_of(run).get("device")
    print(f"\n## check {run.name}{'' if device else ': SIMULATOR, neither passes nor fails (a budget holds or breaks on a phone)'}\n")
    for log in logs_of(run):
        phases = summarize(log)
        observed = percentile(sorted(h for phase in phases.values() for h in phase["hz"]), 0.5)
        rate = hz or observed
        if not rate:
            breaches.append(f"{log.stem}: no callback rate observed; pass --hz")
            continue
        frame = 1000 / rate

        def over(phase, interaction, q, budget, what):
            values = sorted(phases.get(phase, {}).get("i", {}).get(interaction, []))
            value = percentile(values, q)
            if value is not None and value > budget:
                breaches.append(f"{log.stem} {phase}: {interaction} p{round(q * 100)} {value:.1f} ms over {what} ({budget:.1f} ms)")

        for name in phases:
            over(name, "Tab switch", 0.99, frame, f"one frame at {rate:g} Hz")
        for name in phases:
            over(name, "Tab switch (first visit)", 0.99, frame, f"one frame at {rate:g} Hz")
        over("launch", "First frame", 0.5, 400, "the launch budget")
        over("return", "Return to front", 0.99, frame, f"one frame at {rate:g} Hz")
        for name, phase in phases.items():
            if phase["hangs"]:
                breaches.append(f"{log.stem} {name}: {len(phase['hangs'])} hangs, longest {max(phase['hangs']):.0f} ms")
        scrolls = phases.get("scrolls")
        if scrolls and scrolls["late"]:
            breaches.append(f"{log.stem} scrolls: {scrolls['late']} late frames")
        after = phases.get("tabs", {}).get("after_tabs")
        if FOOTPRINT_CEILING_MB is not None and after and after / 2**20 > FOOTPRINT_CEILING_MB:
            breaches.append(f"{log.stem} tabs: {after / 2**20:.0f} MB after the tab switches, over {FOOTPRINT_CEILING_MB} MB")
    print("\n".join(f"- {breach}" for breach in breaches) if breaches else "every budget holds")
    if FOOTPRINT_CEILING_MB is None:
        print("(footprint ceiling not set: FOOTPRINT_CEILING_MB)")
    return breaches if device else []


def check(args):
    if judge(pathlib.Path(args.run), args.hz):
        sys.exit(1)


APP_CODE = re.compile(r"\((Lifestream|LifestreamCaptureCore|HomeLink|Cockpit)\)$")
IDLE = re.compile(r"mach_msg2?_trap|mach_msg_overwrite|__CFRunLoopServiceMachPort")


def trace_stacks(path):
    """The test app's main-thread stacks from an Instruments Time Profiler trace, leaf first, with
    their weight in ms: the Lifestream process with the most main-thread samples (the person's own
    app idles beside it)."""
    import xml.etree.ElementTree as ET
    xml = sh("xcrun", "xctrace", "export", "--input", str(path), "--xpath",
             '/trace-toc/run[@number="1"]/data/table[@schema="time-profile"]', capture=True).stdout
    held, by_pid = {}, {}
    for row in ET.fromstring(xml).iter("row"):
        cells = {}
        for cell in row:
            if "ref" in cell.attrib:
                cell = held[cell.attrib["ref"]]
            elif "id" in cell.attrib:
                held[cell.attrib["id"]] = cell
                for inner in cell.iter():
                    if "id" in inner.attrib:
                        held[inner.attrib["id"]] = inner
            cells[cell.tag] = cell
        backtrace = cells["tagged-backtrace"] if "tagged-backtrace" in cells else cells.get("backtrace")
        thread = cells.get("thread")
        if backtrace is None or thread is None or "Lifestream" not in thread.attrib.get("fmt", ""):
            continue
        frames = []
        for frame in backtrace:
            frame = held.get(frame.attrib.get("ref"), frame)
            binary = frame.find("binary")
            binary = held.get(binary.attrib.get("ref"), binary) if binary is not None else None
            frames.append(f"{frame.attrib.get('name', '?')}  ({binary.attrib.get('name', '?') if binary is not None else '?'})")
        if not any(f.startswith("main  (") or f.startswith("UIApplicationMain  (") for f in frames):
            continue
        pid = re.search(r"pid: (\d+)", thread.attrib["fmt"])
        weight = cells.get("weight")
        by_pid.setdefault(pid and pid[1], []).append((frames, int(weight.text) / 1e6 if weight is not None else 1.0))
    return max(by_pid.values(), key=len) if by_pid else []


def sample_stacks(path):
    """The main thread's stacks from a macOS `sample` file, leaf first, each weighing 1 ms per sample."""
    lines = pathlib.Path(path).read_text(errors="replace").splitlines()
    start = next((i for i, line in enumerate(lines) if "com.apple.main-thread" in line or "Main Thread" in line), None)
    node = re.compile(r"^(?P<pad>[ +!:|]*)(?P<count>\d+) (?P<name>.+?) +\(in (?P<lib>[^)]+)\)")
    stacks, path_, parsed = [], [], False
    for line in lines[(start or 0) + 1:] if start is not None else []:
        match = node.match(line)
        if not match:
            if parsed:
                break
            continue
        parsed = True
        depth, count = len(match["pad"]), int(match["count"])
        name = re.sub(r"\s*\[0x[0-9a-f]+\].*$", "", match["name"]).strip()
        while path_ and path_[-1][0] >= depth:
            done = path_.pop()
            if done[2] > 0:
                stacks.append(([n for _, n, _ in reversed(path_ + [done])], float(done[2])))
        if path_:
            path_[-1][2] -= count
        path_.append([depth, f"{name}  ({match['lib']})", count])
    while path_:
        done = path_.pop()
        if done[2] > 0:
            stacks.append(([n for _, n, _ in reversed(path_ + [done])], float(done[2])))
    return stacks


def hot(args):
    """Where the main thread's busy time went: app functions inclusive, every function by self time."""
    stacks = trace_stacks(args.profile) if args.profile.endswith(".trace") else sample_stacks(args.profile)
    if not stacks:
        sys.exit(f"no main-thread stacks in {args.profile}")
    busy = [(frames, ms) for frames, ms in stacks if frames and not IDLE.search(frames[0])]
    total = sum(ms for _, ms in busy)
    inclusive, own = {}, {}
    for frames, ms in busy:
        own[frames[0]] = own.get(frames[0], 0) + ms
        for name in set(frames):
            inclusive[name] = inclusive.get(name, 0) + ms
    print(f"main thread busy: {total:.0f} ms\n")
    print("| inclusive ms | % of busy | app function |\n|---|---|---|")
    for name, ms in sorted(((n, ms) for n, ms in inclusive.items() if APP_CODE.search(n)), key=lambda x: -x[1])[:args.top]:
        print(f"| {ms:.0f} | {100 * ms / max(total, 1):.0f}% | `{name}` |")
    print("\n| self ms | % of busy | function |\n|---|---|---|")
    for name, ms in sorted(own.items(), key=lambda x: -x[1])[:args.top]:
        print(f"| {ms:.0f} | {100 * ms / max(total, 1):.0f}% | `{name}` |")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    runner = commands.add_parser("run")
    runner.add_argument("--label", required=True)
    runner.add_argument("--scales", default="1,10")
    runner.add_argument("--device")
    runner.add_argument("--cold", action="store_true")
    runner.add_argument("--tests", default="SpeedUITests")
    runner.add_argument("--profile", metavar="TEMPLATE", help="record an Instruments trace beside each scale, e.g. 'Time Profiler'")
    runner.add_argument("--check", action="store_true", help="judge the run against the budgets at the end")
    runner.add_argument("--hz", type=float, choices=(60, 120), help="the display's rate for --check; the observed rate by default")
    checker = commands.add_parser("check")
    checker.add_argument("run")
    checker.add_argument("--hz", type=float, choices=(60, 120), help="the display's rate; the observed rate by default")
    reporter = commands.add_parser("report")
    reporter.add_argument("runs", nargs="+")
    hotter = commands.add_parser("hot")
    hotter.add_argument("profile", help="an x<scale>.trace (a phone's) or x<scale>.sample.txt (a simulator's)")
    hotter.add_argument("--top", type=int, default=25)
    args = parser.parse_args()
    {"run": run, "report": report, "check": check, "hot": hot}[args.command](args)


if __name__ == "__main__":
    main()
