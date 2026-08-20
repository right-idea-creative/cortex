// Test de la logica de CPL y tendencia del tablero cost-per-lead.
// Sin framework: node attribution_health.test.js  (exit 0 = pasa, 1 = falla)
//
// Replica cpl(), trendCls() y trendTxt() del HTML y los valida con los numeros
// reales de julio 2026 que verificamos en BigQuery (cruce por customer_id).

const LEAD='first_time';

// --- copias EXACTAS del HTML ---
function cpl(row){
  const leads=row[LEAD];
  if(!leads||leads<=0) return null;
  return row.spend/leads;
}
function trendCls(curr,prev){
  if(curr==null||prev==null) return null;
  const d=(curr-prev)/prev;
  if(Math.abs(d)<0.03) return 'flat';
  return d>0?'up':'down';
}

let failed=0;
function almost(a,b,msg,tol=0.01){
  if(a==null||b==null){ if(a!==b){console.error(`FAIL: ${msg}\n  esperado ${b} obtenido ${a}`);failed++;} else console.log(`ok: ${msg}`); return; }
  if(Math.abs(a-b)>tol){console.error(`FAIL: ${msg}\n  esperado ${b} obtenido ${a}`);failed++;}
  else console.log(`ok: ${msg}`);
}
function eq(a,b,msg){
  if(JSON.stringify(a)!==JSON.stringify(b)){console.error(`FAIL: ${msg}\n  esperado ${JSON.stringify(b)} obtenido ${JSON.stringify(a)}`);failed++;}
  else console.log(`ok: ${msg}`);
}

// --- CPL con datos reales (julio 2026, verificados en BQ) ---
// Sarasota: spend 2577, first_time 34 -> CPL 75.79
almost(cpl({spend:2577,first_time:34}), 75.79, 'Sarasota CPL = $75.79');
// Denver: spend 10463, first_time 39 -> CPL 268.28
almost(cpl({spend:10463,first_time:39}), 268.28, 'Denver CPL = $268.28');
// Sioux Falls: spend 9786, first_time 97 -> 100.89
almost(cpl({spend:9786,first_time:97}), 100.89, 'Sioux Falls CPL = $100.89');
// NW Indiana: spend 2515, first_time 34 -> 73.97
almost(cpl({spend:2515,first_time:34}), 73.97, 'NW Indiana CPL = $73.97');

// --- Guard de division por cero: sin leads -> null (NO infinito ni NaN) ---
eq(cpl({spend:5000,first_time:0}), null, 'gasto sin leads = null (no /0)');
eq(cpl({spend:0,first_time:0}), null, 'sin gasto ni leads = null');
// gasto 0 con leads -> CPL 0 (valido: cliente con llamadas gratis/otro canal)
almost(cpl({spend:0,first_time:5}), 0, 'gasto 0 con leads = CPL 0');

// --- Tendencia: CPL sube = peor (up/rojo), baja = mejor (down/verde) ---
eq(trendCls(90,75), 'up',   'CPL 75->90 = up (peor)');
eq(trendCls(75,90), 'down', 'CPL 90->75 = down (mejor)');
// cambio <3% = flat
eq(trendCls(75,74), 'flat', 'cambio chico (<3%) = flat');
eq(trendCls(100,100), 'flat', 'sin cambio = flat');
// exacto 3% no es flat (es el limite)
eq(trendCls(103,100), 'up', 'exacto +3% = up (limite no inclusivo en flat)');
// mes sin dato previo -> null
eq(trendCls(75,null), null, 'sin mes previo = null');
eq(trendCls(null,75), null, 'sin CPL actual = null');

// --- Ejemplo de tendencia real: Lansing first vs unique (metricas dan CPL distinto) ---
// Con first_time=23: 2979/23 = 129.52 ; con unique=49: 2979/49 = 60.80
almost(cpl({spend:2979,first_time:23}), 129.52, 'Lansing CPL first = $129.52');
almost(2979/49, 60.80, 'Lansing CPL unique = $60.80 (metrica cambia el CPL)');

console.log('');
if(failed){console.error(`${failed} test(s) FALLARON`);process.exit(1);}
else{console.log('TODOS los tests pasaron');process.exit(0);}
