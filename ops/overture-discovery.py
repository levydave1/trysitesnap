"""Discover US local-business leads from Overture and submit safe batches.

This job performs discovery only. Every accepted lead is stored with
PENDING_EXTERNAL_VERIFICATION and cannot reach Instantly until a separate
verification-results import approves it.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

import duckdb


DEFAULT_RELEASE = "2026-11-18.0"
DEFAULT_URL = "https://trysitesnap.com/api/overture-leads"
RELEASE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}\.\d+$")
STATE_GROUPS = [
    ["CA", "OR", "WA", "AK", "HI"],
    ["TX", "OK", "LA", "AR", "NM"],
    ["FL", "GA", "NC", "SC", "VA", "WV"],
    ["NY", "NJ", "PA", "CT", "MA", "RI", "VT", "NH", "ME"],
    ["OH", "MI", "IN", "IL", "WI", "MN", "IA"],
    ["TN", "KY", "AL", "MS", "MD", "DE", "DC"],
    ["AZ", "CO", "UT", "NV", "ID", "MT", "WY", "KS", "MO", "NE", "SD", "ND"],
]
TARGET_PATTERN = (
    "roof|plumb|hvac|heating|air_condition|electric|landscap|lawn|tree_service|pest|"
    "garage_door|remodel|renovat|general_contractor|paint|floor|tile|fenc|deck|gutter|"
    "window|door|locksmith|cleaning|carpet|pressure_wash|pool|spa|masonry|concrete|"
    "handyman|appliance_repair|moving|storage|auto_repair|body_shop|towing|detail|"
    "salon|barber|nail|massage|chiropract|dental|physical_therap|veterinar|pet_groom|"
    "photograph|event_plann|cater|bakery|restaurant|account|bookkeep|insurance|"
    "real_estate|property_manag|lawyer|law_firm"
)


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Discover Overture leads without sending email")
    parser.add_argument("--release", default=os.getenv("OVERTURE_RELEASE", DEFAULT_RELEASE))
    parser.add_argument("--limit", type=int, default=int(os.getenv("OVERTURE_DISCOVERY_LIMIT", "300")))
    parser.add_argument("--states", default=os.getenv("OVERTURE_STATES", ""))
    parser.add_argument("--output", default=os.getenv("OVERTURE_OUTPUT", ""))
    parser.add_argument("--no-post", action="store_true")
    parser.add_argument("--api-dry-run", action="store_true")
    return parser.parse_args()


def selected_states(raw: str) -> list[str]:
    if raw.strip():
        states = [item.strip().upper() for item in raw.split(",") if item.strip()]
    else:
        states = STATE_GROUPS[dt.datetime.now(dt.timezone.utc).weekday() % len(STATE_GROUPS)]
    if not states or any(not re.fullmatch(r"[A-Z]{2}", item) for item in states):
        raise ValueError("States must be comma-separated two-letter US codes")
    return states


def discover(release: str, states: list[str], limit: int) -> list[dict]:
    if not RELEASE_PATTERN.fullmatch(release):
        raise ValueError("Invalid Overture release name")
    limit = max(1, min(2000, limit))
    source = f"s3://overturemaps-us-west-2/release/{release}/theme=places/type=place/*"
    placeholders = ",".join("?" for _ in states)
    query = f"""
        SELECT
          id,
          names.primary AS name,
          taxonomy.primary AS category,
          confidence,
          operating_status,
          addresses,
          websites,
          emails,
          phones,
          socials,
          brand
        FROM read_parquet('{source}', hive_partitioning=1)
        WHERE upper(coalesce(addresses[1].country, '')) = 'US'
          AND upper(coalesce(addresses[1].region, '')) IN ({placeholders})
          AND lower(coalesce(operating_status, 'open')) IN ('open', 'operational')
          AND confidence >= 0.70
          AND len(emails) > 0
          AND regexp_matches(lower(coalesce(taxonomy.primary, '')), ?)
          AND (hash(id || ?) % 100) < 20
        LIMIT ?
    """
    connection = duckdb.connect()
    connection.execute("INSTALL httpfs")
    connection.execute("LOAD httpfs")
    connection.execute("SET s3_region='us-west-2'")
    seed = dt.datetime.now(dt.timezone.utc).date().isoformat()
    cursor = connection.execute(query, [*states, TARGET_PATTERN, seed, limit])
    columns = [item[0] for item in cursor.description]
    return [dict(zip(columns, row)) for row in cursor.fetchall()]


def post_batches(places: list[dict], url: str, secret: str, dry_run: bool) -> dict:
    totals = {"inspected": 0, "accepted": 0, "created": 0, "pendingExternalVerification": 0}
    rejection_counts: dict[str, int] = {}
    run_name = f"Overture {dt.datetime.now(dt.timezone.utc).date().isoformat()}"
    for index in range(0, len(places), 25):
        body = json.dumps(
            {"places": places[index:index + 25], "run_name": run_name, "dry_run": dry_run},
            default=str,
        ).encode("utf-8")
        request = urllib.request.Request(
            url,
            data=body,
            method="POST",
            headers={"Authorization": f"Bearer {secret}", "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=300) as response:
                result = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")[:1000]
            raise RuntimeError(f"Ingest endpoint returned HTTP {error.code}: {detail}") from error
        for key in totals:
            totals[key] += int(result.get(key, 0))
        for key, value in result.get("rejectionCounts", {}).items():
            rejection_counts[key] = rejection_counts.get(key, 0) + int(value)
    totals["rejectionCounts"] = rejection_counts
    totals["dryRun"] = dry_run
    return totals


def main() -> int:
    args = arguments()
    states = selected_states(args.states)
    places = discover(args.release, states, args.limit)
    output = {"release": args.release, "states": states, "count": len(places), "places": places}
    if args.output:
        path = Path(args.output).resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(output, indent=2, default=str), encoding="utf-8")

    url = os.getenv("OVERTURE_INGEST_URL", DEFAULT_URL).strip()
    secret = os.getenv("OVERTURE_INGEST_SECRET", "").strip()
    if args.no_post:
        print(json.dumps({"success": True, "posted": False, "release": args.release, "states": states, "discovered": len(places)}))
        return 0
    if not secret:
        raise RuntimeError("OVERTURE_INGEST_SECRET is required unless --no-post is used")
    result = post_batches(places, url, secret, args.api_dry_run)
    print(json.dumps({"success": True, "posted": True, "release": args.release, "states": states, **result}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # Keep CI output concise and free of credentials.
        print(json.dumps({"success": False, "error": str(error)[:1000]}), file=sys.stderr)
        raise SystemExit(1)
