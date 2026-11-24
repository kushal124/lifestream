#!/usr/bin/env python3
"""Measure synthetic store reads: python3 benchmarks/differences-cost.py [rows] [--real].

Run `swift build` first. The tool links the package's debug modules so internal measuring
reads use the same code as shipping. Standard output is the repeatable numbers-only artifact.
"""
from pathlib import Path
import subprocess
import sys

package = Path(__file__).resolve().parents[1]
build = package / ".build/debug"
modules = {"Shipping", "Evidence", "HomeLink", "MachineEvents", "InputEvents", "Audio", "BrowserPages", "PhotoLibrary"}
objects = [str(build / f"{name}.o") for name in sorted(modules)]
binary = build / "differences-cost"
subprocess.run(["swiftc", "-parse-as-library", "-I", str(build),
                str(package / "benchmarks/DifferencesCostBenchmark.swift"), *objects,
                "-o", str(binary)], check=True)
subprocess.run([str(binary), *sys.argv[1:]], check=True)
