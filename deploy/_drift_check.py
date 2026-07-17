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

Content drift (2026-07-17): row counts alone MISS value-only fixes — a
recomputed cpue, a corrected rating_ordinal, a remapped species. Those change
no counts, so the audit that fixed MN's 270k->91k cpue and IL's NULL
'Very Good' ordinal looked "in sync" and sat undeployed for a day. We now also
compute a cheap CONTENT FINGERPRINT (aggregate of the value columns) per state,
computed with IDENTICAL SQL locally (sqlite3) and on prod (better-sqlite3), so
"counts match but content differs" is surfaced as drift to ship.

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

# Content fingerprint: one SQL expression that aggregates the VALUE-bearing
# columns, so a value-only change (cpue, rating_ordinal, gear_category,
# species remap, area_acres) shifts the fingerprint even when row counts are
# identical. printf('%.2f', TOTAL(x)) is deterministic across SQLite builds
# (both sides link SQLite); TOTAL() yields 0.0 for empty/all-NULL. Any table
# that's missing (some states lack lake_stocking_metrics) contributes 'NA'.
FINGERPRINT_SQL = {
    "fish_catch": (
        "SELECT COUNT(*)||':'||printf('%.2f',TOTAL(cpue))||':'||printf('%.2f',TOTAL(cpue_effective))"
        "||':'||printf('%.2f',TOTAL(rating_ordinal))||':'||printf('%.2f',TOTAL(average_length))"
        "||':'||printf('%.2f',TOTAL(average_weight))||':'||CAST(TOTAL(LENGTH(species_code)) AS INT)"
        "||':'||CAST(TOTAL(LENGTH(COALESCE(rating,''))) AS INT)"
        "||':'||CAST(TOTAL(LENGTH(COALESCE(gear_category,''))) AS INT)"
        "||':'||COUNT(DISTINCT gear_category) FROM fish_catch"
    ),
    "lakes": (
        "SELECT COUNT(*)||':'||printf('%.2f',TOTAL(area_acres))||':'||printf('%.2f',TOTAL(max_depth_feet)) FROM lakes"
    ),
    "lake_stocking_metrics": (
        "SELECT COUNT(*)||':'||printf('%.2f',TOTAL(adults_per_100ac))||':'||printf('%.2f',TOTAL(adults_est)) FROM lake_stocking_metrics"
    ),
}


def _fingerprint(conn):
    """Combined content fingerprint string for one open DB connection."""
    parts = []
    for name, sql in FINGERPRINT_SQL.items():
        try:
            parts.append(f"{name}={conn.execute(sql).fetchone()[0]}")
        except sqlite3.OperationalError:
            parts.append(f"{name}=NA")
    return "|".join(parts)


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
        counts["_user_version"] = conn.execute("PRAGMA user_version").fetchone()[0]
        counts["_fp"] = _fingerprint(conn)
    return counts


def prod_counts_all(states):
    """Single SSH session — returns dict of state -> {table: count}."""
    # Node script reads each state's DB via better-sqlite3 (already a
    # dependency on the Fly machine for the server itself). One process,
    # one SSH session, no per-state round trip.
    import json as _json
    fp_js = "{" + ",".join(f"{_json.dumps(k)}:{_json.dumps(v)}" for k, v in FINGERPRINT_SQL.items()) + "}"
    node_script = """
        const Database = require('better-sqlite3');
        const states = process.argv.slice(1);
        const tables = ['lakes','surveys','fish_catch','stocking'];
        const FP = __FP__;
        const out = {};
        for (const s of states) {
            const row = {};
            try {
                const db = new Database('/data/' + s + '.db', { readonly: true });
                for (const t of tables) {
                    try { row[t] = db.prepare('SELECT COUNT(*) AS n FROM ' + t).get().n; }
                    catch { row[t] = null; }
                }
                row._user_version = db.pragma('user_version', { simple: true });
                const parts = [];
                for (const [name, sql] of Object.entries(FP)) {
                    try { parts.push(name + '=' + db.prepare(sql).pluck().get()); }
                    catch { parts.push(name + '=NA'); }
                }
                row._fp = parts.join('|');
                db.close();
            } catch (e) {
                row.error = e.message;
            }
            out[s] = row;
        }
        process.stdout.write(JSON.stringify(out));
    """.replace("__FP__", fp_js)
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
    any_content_drift = False
    behind_details = []
    content_drift_states = []

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
        # Schema-version drift (the NE source_url class of regression): the
        # uploaded artifact's user_version must match what we're shipping.
        lv, pv_ver = local.get("_user_version"), p.get("_user_version")
        if pv_ver is not None and lv is not None and lv != pv_ver:
            print(f"  {state:<6} schema user_version local {lv} vs prod {pv_ver} (expected when shipping a schema bump WITH a new image)")
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
        # Content fingerprint: catches value-only changes (recomputed cpue,
        # corrected ordinal, remapped species) that leave row counts untouched.
        lfp, pfp = local.get("_fp"), p.get("_fp")
        if lfp is not None and pfp is not None and lfp != pfp:
            any_content_drift = True
            content_drift_states.append(state)
            print(f"  {state:<6} {'content':<14} {'differs':>10} {'':>10}   ≠ VALUE DRIFT (row counts equal, values changed)")
        print()

    if not any_drift and not any_content_drift:
        print("  All counts and content match. Production is in sync.")
        return 0

    if any_local_behind:
        print("  ⚠  Local is BEHIND production for at least one table:")
        for d in behind_details:
            print(f"     - {d}")
        print("  Uploading would overwrite production with less data.")
        print("  If this is intentional, re-run with --force.")
        return 2

    if any_content_drift and not any_drift:
        print(f"  Row counts match, but CONTENT differs (value-only changes) for: {', '.join(content_drift_states)}")
        print("  Local has updated values to ship. Proceeding.")
        return 0

    if any_content_drift:
        print(f"  (value-only content drift also present for: {', '.join(content_drift_states)})")
    print("  Local has new data to ship. Proceeding.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
