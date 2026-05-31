-- =====================================================================
-- pacing_api — the single view your n8n endpoint serves to the website.
-- One row per client + channel + month, committed and actual joined.
-- The web page derives variance, pacing %, rollups, YTD, and remaining
-- pool from these primitives. n8n node is simply:  SELECT * FROM pacing_api
--
-- Depends on views from budget_pacing_live.sql:
--   committed            (typed view over the Google Sheet external table)
--   actual_spend_all     (union of Google Ads + Sebas's spend feed)
-- Replace `your_project` to match.
-- =====================================================================

CREATE OR REPLACE VIEW `your_project.budget.pacing_api` AS
WITH committed_ch AS (
  SELECT client, channel, year, month, SUM(amount) AS committed
  FROM `your_project.budget.committed`
  GROUP BY client, channel, year, month
)
SELECT
  COALESCE(c.client,  a.client)  AS client,
  COALESCE(c.channel, a.channel) AS channel,
  COALESCE(c.year,    a.year)    AS year,
  COALESCE(c.month,   a.month)   AS month,
  CAST(COALESCE(c.committed, 0) AS FLOAT64) AS committed,
  CAST(COALESCE(a.actual,    0) AS FLOAT64) AS actual
FROM committed_ch c
FULL OUTER JOIN `your_project.budget.actual_spend_all` a
  USING (client, channel, year, month)
WHERE COALESCE(c.year, a.year) = EXTRACT(YEAR FROM CURRENT_DATE());
-- ^ current year only; drop the WHERE if you want multi-year history.
