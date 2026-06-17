"""Nextdoor Ads -> BigQuery daily spend/performance ingestion (Cortex OS).

Spine: synchronous /stats endpoint, advertiser/day grain.
Flow: GET /me -> per advertiser: profile + per-day /stats -> parse -> staging load -> MERGE.
Idempotent on (advertiser_id, report_date) with a trailing re-statement window.
"""

import os
import sys
import logging
from decimal import Decimal, InvalidOperation, ROUND_HALF_EVEN
from datetime import datetime, date, timedelta
from zoneinfo import ZoneInfo

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from google.cloud import bigquery

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("nextdoor_ingest")

ND_BASE = os.environ.get("ND_BASE", "https://ads.nextdoor.com/api/v3")
ND_TOKEN = os.environ["ND_TOKEN"]
GCP_PROJECT = os.environ.get("GCP_PROJECT", "rightidea-cortex")
BQ_DATASET = os.environ.get("BQ_DATASET", "budget")
BQ_TABLE = os.environ.get("BQ_TABLE", "nextdoor_spend_daily")
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "3"))
START_DATE = os.environ.get("START_DATE", "").strip()
END_DATE = os.environ.get("END_DATE", "").strip()
ADVERTISER_IDS = [x.strip() for x in os.environ.get("ADVERTISER_IDS", "").split(",") if x.strip()]
DEFAULT_TZ = os.environ.get("DEFAULT_TZ", "America/New_York")

TARGET = f"{GCP_PROJECT}.{BQ_DATASET}.{BQ_TABLE}"
STAGING = f"{GCP_PROJECT}.{BQ_DATASET}.{BQ_TABLE}_staging"

NUMERIC_SCALE = Decimal("1.000000000")  # BigQuery NUMERIC max scale = 9 fractional digits

DATA_SCHEMA = [
    bigquery.SchemaField("report_date", "DATE", mode="REQUIRED"),
    bigquery.SchemaField("advertiser_id", "STRING", mode="REQUIRED"),
    bigquery.SchemaField("advertiser_name", "STRING"),
    bigquery.SchemaField("currency_code", "STRING"),
    bigquery.SchemaField("billable_spend", "NUMERIC"),
    bigquery.SchemaField("impressions", "INT64"),
    bigquery.SchemaField("clicks", "INT64"),
    bigquery.SchemaField("ctr", "FLOAT64"),
    bigquery.SchemaField("cpc", "NUMERIC"),
    bigquery.SchemaField("cpm", "NUMERIC"),
    bigquery.SchemaField("total_conversions", "INT64"),
    bigquery.SchemaField("lead_conversions", "INT64"),
]
TARGET_SCHEMA = DATA_SCHEMA + [bigquery.SchemaField("load_timestamp", "TIMESTAMP")]


def build_session():
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {ND_TOKEN}"})
    retry = Retry(
        total=5, backoff_factor=1.5,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=("GET",),
    )
    s.mount("https://", HTTPAdapter(max_retries=retry))
    return s


def nd_get(session, path, params=None):
    r = session.get(f"{ND_BASE}{path}", params=params, timeout=60)
    r.raise_for_status()
    return r.json()


def list_advertiser_ids(session):
    if ADVERTISER_IDS:
        log.info("Using ADVERTISER_IDS override: %d ids", len(ADVERTISER_IDS))
        return ADVERTISER_IDS
    me = nd_get(session, "/me")
    rows = me.get("user", {}).get("advertisers_with_access", [])
    ids = [a["id"] for a in rows if a.get("role") != "NO_ACCESS"]
    log.info("Discovered %d advertisers from /me", len(ids))
    return ids


def get_advertiser_meta(session, adv_id):
    a = nd_get(session, f"/advertisers/{adv_id}")
    tz = a.get("timezone") or DEFAULT_TZ
    try:
        ZoneInfo(tz)
    except Exception:
        tz = DEFAULT_TZ
    return {"name": a.get("name"), "currency": a.get("currency"), "timezone": tz}


def parse_money(value):
    if value is None:
        return None
    tokens = str(value).strip().split()
    if not tokens:
        return None
    try:
        return Decimal(tokens[-1]).quantize(NUMERIC_SCALE, rounding=ROUND_HALF_EVEN)
    except InvalidOperation:
        return None


def target_dates(adv_tz):
    if START_DATE and END_DATE:
        start = date.fromisoformat(START_DATE)
        end = date.fromisoformat(END_DATE)
    else:
        today_local = datetime.now(ZoneInfo(adv_tz)).date()
        end = today_local - timedelta(days=1)
        start = end - timedelta(days=LOOKBACK_DAYS - 1)
    out, d = [], start
    while d <= end:
        out.append(d)
        d += timedelta(days=1)
    return out


def has_activity(stats):
    spend = parse_money(stats.get("billable_spend")) or Decimal(0)
    return spend > 0 or (stats.get("impressions") or 0) > 0 or (stats.get("clicks") or 0) > 0


def stats_to_row(report_day, adv_id, meta, stats):
    spend = parse_money(stats.get("billable_spend"))
    cpc = parse_money(stats.get("cpc"))
    cpm = parse_money(stats.get("cpm"))
    return {
        "report_date": report_day.isoformat(),
        "advertiser_id": adv_id,
        "advertiser_name": meta["name"],
        "currency_code": meta["currency"],
        "billable_spend": format(spend, "f") if spend is not None else None,
        "impressions": stats.get("impressions") or 0,
        "clicks": stats.get("clicks") or 0,
        "ctr": stats.get("ctr"),
        "cpc": format(cpc, "f") if cpc is not None else None,
        "cpm": format(cpm, "f") if cpm is not None else None,
        "total_conversions": stats.get("total_conversions") or 0,
        "lead_conversions": stats.get("lead_conversions") or 0,
    }


def collect_rows(session, advertiser_ids):
    rows, failures = [], 0
    for adv_id in advertiser_ids:
        try:
            meta = get_advertiser_meta(session, adv_id)
            for day in target_dates(meta["timezone"]):
                d = day.isoformat()
                stats = nd_get(session, f"/advertisers/{adv_id}/stats",
                               params={"startTime": d, "endTime": d})
                if has_activity(stats):
                    rows.append(stats_to_row(day, adv_id, meta, stats))
            log.info("advertiser %s (%s): ok", adv_id, meta["name"])
        except Exception as exc:
            failures += 1
            log.error("advertiser %s failed: %s", adv_id, exc)
    return rows, failures


def ensure_tables(client):
    for fqtn, schema in ((TARGET, TARGET_SCHEMA), (STAGING, DATA_SCHEMA)):
        table = bigquery.Table(fqtn, schema=schema)
        if fqtn == TARGET:
            table.time_partitioning = bigquery.TimePartitioning(field="report_date")
            table.clustering_fields = ["advertiser_id"]
        client.create_table(table, exists_ok=True)


def load_staging(client, rows):
    job_config = bigquery.LoadJobConfig(
        schema=DATA_SCHEMA,
        write_disposition=bigquery.WriteDisposition.WRITE_TRUNCATE,
    )
    client.load_table_from_json(rows, STAGING, job_config=job_config).result()


def merge_into_target(client):
    sql = f"""
    MERGE `{TARGET}` AS target
    USING `{STAGING}` AS source
    ON target.advertiser_id = source.advertiser_id
       AND target.report_date = source.report_date
    WHEN MATCHED THEN UPDATE SET
      advertiser_name = source.advertiser_name,
      currency_code = source.currency_code,
      billable_spend = source.billable_spend,
      impressions = source.impressions,
      clicks = source.clicks,
      ctr = source.ctr,
      cpc = source.cpc,
      cpm = source.cpm,
      total_conversions = source.total_conversions,
      lead_conversions = source.lead_conversions,
      load_timestamp = CURRENT_TIMESTAMP()
    WHEN NOT MATCHED THEN INSERT (
      report_date, advertiser_id, advertiser_name, currency_code,
      billable_spend, impressions, clicks, ctr, cpc, cpm,
      total_conversions, lead_conversions, load_timestamp
    ) VALUES (
      source.report_date, source.advertiser_id, source.advertiser_name, source.currency_code,
      source.billable_spend, source.impressions, source.clicks, source.ctr, source.cpc, source.cpm,
      source.total_conversions, source.lead_conversions, CURRENT_TIMESTAMP()
    )
    """
    job = client.query(sql)
    job.result()
    return job.num_dml_affected_rows


def main():
    session = build_session()
    advertiser_ids = list_advertiser_ids(session)
    if not advertiser_ids:
        log.error("No advertisers resolved; aborting")
        sys.exit(1)

    rows, failures = collect_rows(session, advertiser_ids)
    log.info("Collected %d active account-day rows (%d advertiser failures)", len(rows), failures)

    if not rows:
        log.info("No active rows in window; nothing to load")
        return

    client = bigquery.Client(project=GCP_PROJECT)
    ensure_tables(client)
    load_staging(client, rows)
    affected = merge_into_target(client)
    log.info("MERGE complete: %s rows affected in %s", affected, TARGET)


if __name__ == "__main__":
    main()
