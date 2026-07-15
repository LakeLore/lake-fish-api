#!/usr/bin/env python3
"""
_drift_check.py — Compare local state DB row counts against production.

Used by ../deploy-data.sh as a pre-upload safety check. Run standalone to
just inspect drift:

    ./deploy-data.sh --check
    ./deploy-data.sh --check mn sd

Exit codes:
    0 — no drift, or local is ahead of production (typical "new data to
        ship" case)
    2 — local has FEWER rows than production for at least one table,
        OR a table that exists in production is missing locally
        (suggests you're about to overwrite production with a stale or
        incomplete snapshot — almost always unintended)

Drift is checked across these tables:

    lakes, surveys, fish_catch, stocking

Schema-level drift (e.g. NE was missing surveys.source_url for weeks) is
out of scope here. Add a column-presence check if that bites again.
"""

import sqlite3
import subprocess
import sys
from pathlib import Path

APP = "lake-fish-api"
ROOT = Path(__file__).resolve().parents[2]  # ~ (project root)
FLY = str(Path.home() / ".fly" / "bin" / "fly")

LEGACY_PATHS = {
    "mn": ROOT / "mn-lake-fish" / "data" / "lakes.db",
    "sd": ROOT / "sd-lake-fish" / "data" / "sd_lakes.db",
    "nd": ROOT / "nd-lake-fish" / "data" / "lakes.db",
    "ia": ROOT / "ia-lake-fish" / "data" / "lakes.db",
    "ne": ROOT / "ne-lake-fish" / "data" / "lakes.db",
    "wi": ROOT / "wi-lake-fish" / "data" / "lakes.db",
    "mi": ROOT / "mi-lake-fish" / "data" / "lakes.db",
}


def _canonical_states():
    """States flagged canonical in the lakelore-data registry (empty set if
    the registry isn't present — legacy behavior)."""
    reg = ROOT / "lakelore-data" / "registry" / "states.json"
    if not reg.exists():
        return set()
    import json
    with open(reg) as f:
        states = json.load(f)["states"]
    return {s for s, e in states.items() if e.get("canonical")}


def _local_path(state: str):
    """Canonical states compare their canonical artifact (what actually gets
    uploaded); legacy states compare the raw scraper DB."""
    if state in _canonical_states():
        canonical = ROOT / "lakelore-data" / "out" / f"{state}.db"
        if canonical.exists():
            return canonical
    return LEGACY_PATHS.get(state)


def _registry_states():
    """All states in the lakelore-data registry (falls back to the legacy
    seven if the registry isn't present)."""
    reg = ROOT / "lakelore-data" / "registry" / "states.json"
    if not reg.exists():
        return list(LEGACY_PATHS.keys())
    import json
    with open(reg) as f:
        return list(json.load(f)["states"].keys())


LOCAL_PATHS = {s: _local_path(s) for s in _registry_states()}
ALL_STATES = list(LOCAL_PATHS.keys())
TABLES = ["lakes", "surveys", "fish_catch", "stocking"]


def local_counts(state: str):
    path = LOCAL_PATHS.get(state)
    if not path or not path.exists():
        return None
    counts = {}
    with sqlite3.connect(str(path)) as conn:
        for t in TABLES:
            try:
                counts[t] = conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
            except sqlite3.OperationalError:
                counts[t] = None
    return counts


def prod_counts_all(states):
    """Single SSH session — returns dict of state -> {table: count}."""
    # Node script reads each state's DB via better-sqlite3 (already a
    # dependency on the Fly machine for the server itself). One process,
    # one SSH session, no per-state round trip.
    node_script = """
        const Database = require('better-sqlite3');
        const states = process.argv.slice(1);
        const tables = ['lakes','surveys','fish_catch','stocking'];
        const out = {};
        for (const s of states) {
            const row = {};
            try {
                const db = new Database('/data/' + s + '.db', { readonly: true });
                for (const t of tables) {
                    try { row[t] = db.prepare('SELECT COUNT(*) AS n FROM ' + t).get().n; }
                    catch { row[t] = null; }
                }
                db.close();
            } catch (e) {
                row.error = e.message;
            }
            out[s] = row;
        }
        process.stdout.write(JSON.stringify(out));
    """
    # Use the remote shell to run node with our script + args
    cmd = f"node -e {sh_squote(node_script)} -- " + " ".join(states)
    result = subprocess.run(
        [FLY, "ssh", "console", "--app", APP, "-C", cmd],
        capture_output=True, text=True, timeout=90,
    )
    if result.returncode != 0:
        print(f"  ⚠  flyctl ssh failed: {result.stderr.strip()}", file=sys.stderr)
        return {}
    # flyctl prefixes with "Connecting to ..." — strip until we find the JSON
    stdout = result.stdout
    start = stdout.find("{")
    if start < 0:
        print(f"  ⚠  unexpected ssh output:\n{stdout}", file=sys.stderr)
        return {}
    try:
        import json
        return json.loads(stdout[start:].strip())
    except json.JSONDecodeError as e:
        print(f"  ⚠  could not parse production response: {e}\n{stdout}", file=sys.stderr)
        return {}


def sh_squote(s: str) -> str:
    """Wrap a string in single quotes safely for POSIX shells."""
    return "'" + s.replace("'", "'\\''") + "'"


def fmt_int(n):
    if n is None:
        return "—"
    return f"{n:>10,}"


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    requested = args if args else ALL_STATES
    states = [s for s in requested if s in LOCAL_PATHS]
    unknown = [s for s in requested if s not in LOCAL_PATHS]
    for u in unknown:
        print(f"  ⚠  unknown state '{u}', skipping", file=sys.stderr)

    if not states:
        print("No states to check.", file=sys.stderr)
        return 1

    print(f"Drift check vs production ({APP})…", flush=True)
    prod = prod_counts_all(states)

    print()
    print(f"  {'STATE':<6} {'TABLE':<14} {'LOCAL':>10} {'PROD':>10} {'DRIFT':>10}")
    print("  " + "─" * 56)

    any_drift = False
    any_local_behind = False
    behind_details = []

    for state in states:
        local = local_counts(state)
        if local is None:
            print(f"  {state:<6} (local file missing — skipping)")
            continue
        p = prod.get(state) or {}
        if p.get("error"):
            print(f"  {state:<6} (prod error: {p['error']})")
            any_drift = True
            continue
        for t in TABLES:
            l = local.get(t)
            pv = p.get(t)
            mark = ""
            drift_val = ""
            if l is None and pv is not None and pv > 0:
                mark = "  ↓ LOCAL MISSING TABLE"
                drift_val = f"-{pv:,}"
                any_local_behind = True
                any_drift = True
                behind_details.append(
                    f"{state}.{t}: local table MISSING, prod has {pv:,} rows"
                )
            elif l is None or pv is None:
                drift_val = "—"
            else:
                d = l - pv
                drift_val = f"{d:+,}"
                if d > 0:
                    mark = "  ↑ local ahead"
                    any_drift = True
                elif d < 0:
                    mark = "  ↓ LOCAL BEHIND"
                    any_local_behind = True
                    any_drift = True
                    behind_details.append(f"{state}.{t}: local {l:,} < prod {pv:,}")
            print(f"  {state:<6} {t:<14} {fmt_int(l)} {fmt_int(pv)} {drift_val:>10}{mark}")
        print()

    if not any_drift:
        print("  All counts match. Production is in sync.")
        return 0

    if any_local_behind:
        print("  ⚠  Local is BEHIND production for at least one table:")
        for d in behind_details:
            print(f"     - {d}")
        print("  Uploading would overwrite production with less data.")
        print("  If this is intentional, re-run with --force.")
        return 2

    print("  Local has new data to ship. Proceeding.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
