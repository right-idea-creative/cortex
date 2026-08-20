// Test de la logica de captura/gap del tablero call-attribution.
// Sin framework: node attribution_health.test.js  (exit 0 = pasa, 1 = falla)
//
// Replica health() y el calculo de gap del HTML, y los valida contra los
// numeros reales del Test B (julio 2026) que ya verificamos en BigQuery.

// --- copia EXACTA de health() del HTML ---
function health(ctmUnique, gConv){
  if (gConv == null) return { cls:'grey', label:'not mapped' };
  if (gConv === 0)  return { cls:'grey', label:'no Google conv' };
  const pct = ctmUnique / gConv;
  if (pct < 0.70) return { cls:'amber', label: Math.round(pct*100)+'% — under' };
  if (pct > 1.30) return { cls:'red',   label: Math.round(pct*100)+'% — over' };
  return { cls:'green', label: Math.round(pct*100)+'% — ok' };
}

let failed = 0;
function eq(actual, expected, msg){
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e){ console.error(`FAIL: ${msg}\n  esperado ${e}\n  obtenido ${a}`); failed++; }
  else console.log(`ok: ${msg}`);
}

// --- Casos reales del Test B (period_unique CTM vs conv_google), julio 2026 ---
// Estos son los datos que confirmamos en BigQuery.

// TRACKING ROTO: CTM captura muy poco -> amber (under)
// Eugene: Google 118, CTM unique ~1 (era 1 de total, unique similar)
eq(health(1, 118).cls, 'amber', 'Eugene (1/118) = under/amber');
// Bowling Green: Google 197, CTM unique bajo
eq(health(20, 197).cls, 'amber', 'Bowling Green bajo = under/amber');

// SANO: captura 70-130% -> green
// Sarasota con Period Unique: 45 unique / 37 conv = 122% -> green
eq(health(45, 37).cls, 'green', 'Sarasota (45/37 = 122%) = ok/green');
// Dubuque: 79 / ~85 -> ~93% green
eq(health(79, 85).cls, 'green', 'Dubuque (~93%) = ok/green');
// Memphis: 41 / 41 = 100% green
eq(health(41, 41).cls, 'green', 'Memphis (100%) = ok/green');

// SOBRE-ATRIBUCION: >130% -> red
// Permian Basin: 76 unique / 33 conv = 230% -> red
eq(health(76, 33).cls, 'red', 'Permian Basin (76/33 = 230%) = over/red');
// Denver: 46 / 24 = 192% -> red
eq(health(46, 24).cls, 'red', 'Denver (46/24 = 192%) = over/red');

// SIN MAPEO: conv null -> grey
eq(health(0, null).cls, 'grey', 'sin customer_id mapeado = grey');
// Google reporta 0 conv -> grey
eq(health(10, 0).cls, 'grey', 'Google 0 conv = grey');

// --- Bordes exactos del umbral (edge-case-correct, no flimsy) ---
// exactamente 70% -> green (no amber): 70/100
eq(health(70, 100).cls, 'green', 'exacto 70% = green (limite inferior inclusivo)');
// justo debajo de 70%: 69/100 -> amber
eq(health(69, 100).cls, 'amber', 'justo <70% = amber');
// exactamente 130% -> green: 130/100
eq(health(130, 100).cls, 'green', 'exacto 130% = green (limite superior inclusivo)');
// justo arriba de 130%: 131/100 -> red
eq(health(131, 100).cls, 'red', 'justo >130% = red');

// --- Calculo de gap (unique - conv), signo correcto ---
function gap(unique, conv){ return unique - conv; }
eq(gap(45, 37), 8,   'gap Sarasota = +8 (CTM ligeramente arriba)');
eq(gap(1, 118), -117,'gap Eugene = -117 (CTM muy por debajo = conversiones perdidas)');
eq(gap(76, 33), 43,  'gap Permian = +43 (CTM sobre-cuenta)');

console.log('');
if (failed){ console.error(`${failed} test(s) FALLARON`); process.exit(1); }
else { console.log('TODOS los tests pasaron'); process.exit(0); }
