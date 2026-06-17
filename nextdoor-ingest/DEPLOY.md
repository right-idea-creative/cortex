# Nextdoor → BigQuery ingestion — deploy runbook

GCP project: `rightidea-cortex` · Region assumed: `us-central1` · Dataset: `budget`

## 0. Local smoke test (run before deploying)
Uses your existing ADC. Restricts to one active advertiser so it's fast.

```bash
export ND_TOKEN='<token from ads.nextdoor.com>'
export GCP_PROJECT='rightidea-cortex'
export ADVERTISER_IDS='923674829746341769'
export START_DATE='2026-05-17'
export END_DATE='2026-06-15'
pip install -r requirements.txt
python nextdoor_to_bq.py
```
Then verify in BigQuery:
```sql
SELECT report_date, advertiser_name, billable_spend, impressions, clicks, lead_conversions
FROM `rightidea-cortex.budget.nextdoor_spend_daily`
ORDER BY report_date;
```

## 1. Store the token in Secret Manager
```bash
printf '%s' "$ND_TOKEN" | gcloud secrets create nextdoor-ads-token \
  --project rightidea-cortex --data-file=-
# later rotations:
# printf '%s' "$NEW_TOKEN" | gcloud secrets versions add nextdoor-ads-token --data-file=-
```

## 2. Service account + IAM
```bash
gcloud iam service-accounts create cortex-nextdoor \
  --project rightidea-cortex --display-name "Cortex Nextdoor ingestion"

SA=cortex-nextdoor@rightidea-cortex.iam.gserviceaccount.com

gcloud projects add-iam-policy-binding rightidea-cortex \
  --member="serviceAccount:$SA" --role=roles/bigquery.dataEditor
gcloud projects add-iam-policy-binding rightidea-cortex \
  --member="serviceAccount:$SA" --role=roles/bigquery.jobUser
gcloud secrets add-iam-policy-binding nextdoor-ads-token \
  --project rightidea-cortex \
  --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor
```

## 3. Deploy the Cloud Run Job
```bash
gcloud run jobs deploy cortex-nextdoor-ingest \
  --source . --region us-central1 --project rightidea-cortex \
  --service-account "$SA" \
  --set-secrets ND_TOKEN=nextdoor-ads-token:latest \
  --set-env-vars GCP_PROJECT=rightidea-cortex,BQ_DATASET=budget,BQ_TABLE=nextdoor_spend_daily,LOOKBACK_DAYS=3 \
  --max-retries 1 --task-timeout 1800
```

## 4. Backfill (one-off, override the date window for this execution)
```bash
gcloud run jobs execute cortex-nextdoor-ingest \
  --region us-central1 --project rightidea-cortex \
  --update-env-vars START_DATE=2026-01-01,END_DATE=2026-06-15
```

## 5. Schedule the daily run
Scheduler triggers the Job via the Run Jobs API. Runs 09:00 ET (prior day is stable by then).
```bash
gcloud projects add-iam-policy-binding rightidea-cortex \
  --member="serviceAccount:$SA" --role=roles/run.invoker

gcloud scheduler jobs create http cortex-nextdoor-daily \
  --location us-central1 --project rightidea-cortex \
  --schedule "0 9 * * *" --time-zone "America/New_York" \
  --uri "https://us-central1-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/rightidea-cortex/jobs/cortex-nextdoor-ingest:run" \
  --http-method POST \
  --oauth-service-account-email "$SA"
```

## Environment variables reference
| var | default | purpose |
|---|---|---|
| `ND_TOKEN` | (required) | Bearer token, mounted from Secret Manager |
| `GCP_PROJECT` | `rightidea-cortex` | target project |
| `BQ_DATASET` | `budget` | target dataset |
| `BQ_TABLE` | `nextdoor_spend_daily` | target table |
| `LOOKBACK_DAYS` | `3` | trailing re-statement window for daily runs |
| `START_DATE` / `END_DATE` | (empty) | override window (backfill); inclusive, `YYYY-MM-DD` |
| `ADVERTISER_IDS` | (empty) | comma-separated subset; default pulls all from `/me` |
| `DEFAULT_TZ` | `America/New_York` | fallback when an advertiser profile lacks a timezone |
