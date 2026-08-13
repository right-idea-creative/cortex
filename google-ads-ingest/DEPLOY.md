# Google Ads API → BigQuery ingestion — deploy runbook (Alert Phase 2)

GCP project: `rightidea-cortex` · Region: `us-central1` · Dataset: `raw_google_ads`
Auth: OAuth creds from Secret Manager (4 secrets), read at runtime by the job's SA.

## What it does
Queries the Google Ads API (v25) via GAQL across all accounts under Master MCC 611
(login_customer_id=6118198619), writes 3 snapshot tables:
- `gads_ad_policy`   — ad approval + disapproval reason (policy_topic_entries)
- `gads_call_assets` — CALL asset approval (phone disapproved)
- `gads_billing`     — billing_setup + account_budget status

Alert views (`transformed.alert_url_disapproved`, `_phone_disapproved`,
`_billing_problem`) read the latest snapshot.

## SA + IAM (one-time, already done)
SA: `cortex-gads-ingest@rightidea-cortex.iam.gserviceaccount.com`
- secretmanager.secretAccessor on: google-ads-developer-token, -client-id,
  -client-secret, -refresh-token
- bigquery.dataEditor + bigquery.jobUser (project)
- run.invoker (for Scheduler)

## Deploy (from this dir)
```bash
SA=cortex-gads-ingest@rightidea-cortex.iam.gserviceaccount.com
gcloud run jobs deploy cortex-gads-ingest \
  --source . --region us-central1 --project rightidea-cortex \
  --service-account "$SA" \
  --set-env-vars GCP_PROJECT=rightidea-cortex,BQ_DATASET=raw_google_ads,LOGIN_CUSTOMER_ID=6118198619 \
  --max-retries 1 --task-timeout 1800
```
Note: NO --set-secrets. The code reads Secret Manager directly (the SA has secretAccessor).

## Run manually / backfill
```bash
gcloud run jobs execute cortex-gads-ingest --region us-central1 --project rightidea-cortex
# test subset: --update-env-vars MAX_ACCOUNTS=3
```

## Daily schedule (already created)
`cortex-gads-daily` — 08:00 ET, triggers the job via Run Jobs API.

## Env vars
| var | default | purpose |
|---|---|---|
| GCP_PROJECT | rightidea-cortex | project |
| BQ_DATASET | raw_google_ads | target dataset |
| LOGIN_CUSTOMER_ID | 6118198619 | Master MCC (auth from here reaches all children) |
| MAX_ACCOUNTS | 0 | limit accounts for testing (0 = all) |
