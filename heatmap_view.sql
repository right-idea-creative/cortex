-- ============================================================================
-- transformed.client_heatmap_90d
-- ----------------------------------------------------------------------------
-- Una fila por (cliente x ZIP). Alimenta el mapa de calor de Cortex.
--
-- DOS CAPAS VISUALES:
--   * COLOR     -> cpa_90d  (verde = CPA sano, rojo = CPA caro)
--   * DENSIDAD  -> zip_count + un punto por ZIP (cobertura / footprint)
--
-- GRANO: ZIP real a nivel cliente. Las metricas (spend, conv, CPA) viven a
-- nivel CID y se PROYECTAN sobre cada ZIP del cliente (BigQuery no tiene
-- spend/conv por ZIP; todo entra por un CID que cubre todas las sedes).
-- Leer el color como "CPA del cliente pintado en su zona", NO como CPA por ZIP.
--
-- VENTANA: ultimos 90 dias desde CURRENT_DATE().
-- GEO: centroids del dataset publico geo_us_boundaries.zip_codes (cero mant.).
--
-- DEPENDENCIA PENDIENTE: la columna `main_locations_zips` AUN NO existe en
-- reference.client_mapping. Hay que agregar al nodo n8n "Transform to Bigquery
-- Schema" la linea:  main_locations_zips: col('long_text_mm318xhs'),
-- y correr el sync una vez. Hasta entonces, esta VIEW devuelve 0 filas.
-- ============================================================================

CREATE OR REPLACE VIEW `rightidea-cortex.transformed.client_heatmap_90d` AS

WITH geo AS (
  -- Explota la lista de ZIPs a una fila por ZIP. Solo 5 digitos validos:
  -- prosa tipo "20-mile radius" se descarta sola por el REGEXP.
  SELECT
    cm.client_name,
    cm.vertical,
    cm.state AS primary_state,
    -- Blindaje del CID: limpia no-digitos y castea; invalidos -> NULL (no rompe)
    SAFE_CAST(REGEXP_REPLACE(cm.google_ads_customer_id, r'[^0-9]', '') AS INT64) AS cid,
    TRIM(z) AS zip
  FROM `rightidea-cortex.reference.client_mapping` AS cm,
       UNNEST(SPLIT(cm.main_locations_zips, ',')) AS z
  WHERE cm.main_locations_zips IS NOT NULL
    AND REGEXP_CONTAINS(TRIM(z), r'^\d{5}$')
),

spend AS (
  -- Spend de Google a 90 dias, agregado por cuenta. spend ya es FLOAT64 (no micros).
  -- Filtra a Google: esta tabla combina varias plataformas.
  SELECT
    SAFE_CAST(customer_id AS INT64) AS cid,
    SUM(spend) AS spend_90d
  FROM `rightidea-cortex.transformed.spend_combined`
  WHERE LOWER(platform) = 'google'
    AND spend_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY)
  GROUP BY cid
),

conv AS (
  -- Conversiones de Google a 90 dias. La tabla esta segmentada por accion/device/
  -- network: hay varias filas por cuenta/dia -> SUM agrupando por customer_id.
  SELECT
    customer_id AS cid,
    SUM(metrics_conversions) AS conversions_90d
  FROM `rightidea-cortex.raw_google_ads.ads_AccountConversionStats_6118198619`
  WHERE segments_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY)
  GROUP BY cid
),

zip_counts AS (
  -- Footprint: cuantos ZIPs distintos cubre cada cliente (capa de cobertura).
  SELECT cid, COUNT(DISTINCT zip) AS zip_count
  FROM geo
  GROUP BY cid
)

SELECT
  g.client_name,
  g.cid                                   AS google_ads_customer_id,
  g.zip,
  g.vertical,
  g.primary_state,
  zip.internal_point_lat                  AS lat,
  zip.internal_point_lon                  AS lng,
  s.spend_90d,
  c.conversions_90d,
  SAFE_DIVIDE(s.spend_90d, c.conversions_90d) AS cpa_90d,   -- COLOR del calor
  zc.zip_count,                                             -- COBERTURA
  CURRENT_TIMESTAMP()                     AS view_refreshed_at
FROM geo AS g
LEFT JOIN zip_counts AS zc USING (cid)
LEFT JOIN spend       AS s  USING (cid)
LEFT JOIN conv        AS c  USING (cid)
LEFT JOIN `bigquery-public-data.geo_us_boundaries.zip_codes` AS zip
  ON g.zip = zip.zip_code;

-- ============================================================================
-- QUERIES DE VERIFICACION (correr tras crear la VIEW, una vez existan los ZIPs)
-- ============================================================================

-- 1. Conteo de puntos del mapa (filas = cliente x ZIP)
-- SELECT COUNT(*) AS row_count FROM `rightidea-cortex.transformed.client_heatmap_90d`;

-- 2. ZIPs que no geocodificaron (lat NULL = ZIP no esta en el dataset publico)
-- SELECT client_name, zip FROM `rightidea-cortex.transformed.client_heatmap_90d`
-- WHERE lat IS NULL ORDER BY client_name;

-- 3. Clientes sin metricas (CID no matchea spend/conv -> sin Google o CID malo)
-- SELECT DISTINCT client_name, google_ads_customer_id
-- FROM `rightidea-cortex.transformed.client_heatmap_90d`
-- WHERE spend_90d IS NULL ORDER BY client_name;

-- 4. Sanity del CPA por cliente
-- SELECT client_name, ANY_VALUE(spend_90d) AS spend_90d,
--        ANY_VALUE(conversions_90d) AS conv_90d, ANY_VALUE(cpa_90d) AS cpa_90d
-- FROM `rightidea-cortex.transformed.client_heatmap_90d`
-- GROUP BY client_name ORDER BY cpa_90d DESC;
