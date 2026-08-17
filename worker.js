/**
 * 診断ページ本体は public/ の静的HTMLがそのまま担当する。
 * このWorkerは、それに (1) 完了計測の受け口 (2) 計測を見る非公開ページ、の2つだけを足す。
 */

const TYPE_KEYS = ["type1", "type2", "type3", "type4"];

function dayKey(date) {
  return date.toISOString().slice(0, 10);
}

async function incr(kv, key) {
  // KVには数値のatomic incrementが無いので、読んで+1して書き戻す。
  // 同時アクセスが数件/秒を超える規模になったら競合し得るが、いまの規模では問題にならない。
  const current = parseInt((await kv.get(key)) ?? "0", 10);
  const next = current + 1;
  await kv.put(key, String(next));
  return next;
}

async function handleComplete(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }
  const type = TYPE_KEYS.includes(body?.type) ? body.type : "unknown";
  const hasGclid = typeof body?.gclid === "string" && body.gclid.length > 0;

  const now = new Date();
  const day = dayKey(now);

  await Promise.all([
    incr(env.STATS, "complete:total"),
    incr(env.STATS, `complete:day:${day}`),
    incr(env.STATS, `complete:type:${type}`),
    hasGclid ? incr(env.STATS, "complete:from_google_ads") : Promise.resolve(),
    hasGclid ? incr(env.STATS, `complete:from_google_ads:day:${day}`) : Promise.resolve(),
  ]);

  return new Response(null, { status: 204 });
}

async function handleStats(request, env) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  if (!env.STATS_SECRET || key !== env.STATS_SECRET) {
    return new Response("Not Found", { status: 404 });
  }

  const days = [];
  const now = new Date();
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    days.push(dayKey(d));
  }

  const [total, fromAds, ...rest] = await Promise.all([
    env.STATS.get("complete:total"),
    env.STATS.get("complete:from_google_ads"),
    ...days.map((d) => env.STATS.get(`complete:day:${d}`)),
    ...days.map((d) => env.STATS.get(`complete:from_google_ads:day:${d}`)),
    ...TYPE_KEYS.map((t) => env.STATS.get(`complete:type:${t}`)),
  ]);
  const dayTotals = rest.slice(0, days.length);
  const dayAdsTotals = rest.slice(days.length, days.length * 2);
  const typeTotals = rest.slice(days.length * 2);

  const rows = days
    .map((d, i) => {
      const c = dayTotals[i] ?? "0";
      const g = dayAdsTotals[i] ?? "0";
      return `<tr><td style="padding:6px 0;color:#666">${d}</td><td style="padding:6px 0;text-align:right;font-weight:600">${c}件</td><td style="padding:6px 0;text-align:right;color:#888">(うちGoogle広告経由 ${g})</td></tr>`;
    })
    .join("");

  const typeRows = TYPE_KEYS.map((t, i) => {
    const label = { type1: "準備万端", type2: "知識先行・実践不足", type3: "情報不足・不安先行", type4: "楽観マイペース" }[t];
    return `<tr><td style="padding:6px 0;color:#666">${label}</td><td style="padding:6px 0;text-align:right;font-weight:600">${typeTotals[i] ?? "0"}件</td></tr>`;
  }).join("");

  const html = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>診断 利用状況</title>
<meta name="robots" content="noindex">
<style>
  body{font-family:-apple-system,"Hiragino Kaku Gothic ProN",sans-serif;max-width:520px;margin:40px auto;padding:0 20px;color:#222}
  h1{font-size:20px}
  h2{font-size:14px;color:#666;margin-top:32px}
  table{width:100%;border-collapse:collapse;font-size:14px}
  tr{border-bottom:1px solid #eee}
</style></head>
<body>
<h1>AI時代の対応力診断 - 利用状況</h1>
<p>合計完了数: <strong>${total ?? "0"}件</strong>(うちGoogle広告のクリック経由: <strong>${fromAds ?? "0"}件</strong>)</p>
<h2>直近14日</h2>
<table>${rows}</table>
<h2>タイプ別内訳(累計)</h2>
<table>${typeRows}</table>
</body></html>`;

  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/complete" && request.method === "POST") {
      return handleComplete(request, env);
    }
    if (url.pathname === "/stats" && request.method === "GET") {
      return handleStats(request, env);
    }

    return env.ASSETS.fetch(request);
  },
};
