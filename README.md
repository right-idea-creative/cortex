# Cortex OS

Internal operations platform for Right Idea Media & Creative.

## Modules

| Module | URL | Data source | Refresh |
| --- | --- | --- | --- |
| Call Tracking | `/call-tracking.html` | `data.json` (CTM + Google Ads) | Manual via `export_data.py` |
| Ad Spend Pacing | `/ad-spend-pacing.html` | `pacing-data.json` (BigQuery `pacing_dashboard_view`) | Auto-daily via GitHub Actions (8 AM CT) |
| Tickets | `/tickets.html` | n8n webhook (live) | Live |

## Ad Spend Pacing module

Reads `rightidea-cortex.transformed.pacing_dashboard_view` and renders a static
dashboard with current-month KPIs, status distribution, attention list, BQ vs
Planner capture analysis, and full rolling-window account table.

### Local development

```bash
# One-time setup
gcloud auth application-default login
pip install -r requirements.txt

# Regenerate pacing-data.json
python export_pacing_data.py

# Open the dashboard in browser (load via local server, not file://, to allow fetch())
python -m http.server 8000
# Visit http://localhost:8000/ad-spend-pacing.html
```

### Automated refresh

GitHub Actions workflow `.github/workflows/refresh-pacing.yml` runs daily at
14:00 UTC (≈ 8 AM Central). It:

1. Authenticates to GCP via service account key stored in `GCP_SA_KEY` secret.
2. Runs `python export_pacing_data.py`.
3. Commits & pushes `pacing-data.json` if it changed.
4. Cloudflare Pages auto-deploys the new content.

Manual trigger available from the GitHub Actions UI (workflow_dispatch).

### Required GitHub secret

`GCP_SA_KEY`: JSON key of a GCP service account with the following roles on
`rightidea-cortex`:
- `roles/bigquery.dataViewer`
- `roles/bigquery.jobUser`

See setup steps in the deploy guide.
