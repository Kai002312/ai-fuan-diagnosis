/**
 * 診断ページ本体は public/ の静的HTMLがそのまま担当する。
 * このWorkerは、それに (1) 完了・遷移の計測の受け口 (2) 計測を見る非公開ページ、の2つだけを足す。
 */

const TYPE_KEYS = ["type1", "type2", "type3", "type4"];
const TYPE_LABELS = {
  type1: "準備万端",
  type2: "知識先行・実践不足",
  type3: "情報不足・不安先行",
  type4: "楽観マイペース",
};
// 結果画面から外に出ていく導線。noteが購入ページ、shareがXシェア。
const CLICK_TARGETS = ["note", "share"];

const DAYS_SHOWN = 14;

function dayKey(date) {
  // 広告の管理画面(JST)と突き合わせるので、日付の区切りもJSTに合わせる。
  return new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function incr(kv, key) {
  // KVには数値のatomic incrementが無いので、読んで+1して書き戻す。
  // 同時アクセスが数件/秒を超える規模になったら競合し得るが、いまの規模では問題にならない。
  const current = parseInt((await kv.get(key)) ?? "0", 10);
  await kv.put(key, String(current + 1));
}

// 日別のカウンターは1日1キーのJSONにまとめている。
// 指標ごとに別キーにするとKV読み書き(=subrequest)が指標数×日数で増え、
// Workersの1リクエストあたりのsubrequest上限に早々に当たるため。
async function incrDay(kv, day, fields) {
  const key = `day:${day}`;
  let bucket = {};
  try {
    bucket = JSON.parse((await kv.get(key)) ?? "{}");
  } catch {
    bucket = {};
  }
  for (const field of fields) {
    bucket[field] = (parseInt(bucket[field], 10) || 0) + 1;
  }
  await kv.put(key, JSON.stringify(bucket));
}

async function readDay(kv, day) {
  try {
    return JSON.parse((await kv.get(`day:${day}`)) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

function num(value) {
  return parseInt(value, 10) || 0;
}

function rate(numerator, denominator) {
  if (!denominator) return "-";
  return ((numerator / denominator) * 100).toFixed(1) + "%";
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
  const day = dayKey(new Date());

  await Promise.all([
    incr(env.STATS, "complete:total"),
    incr(env.STATS, `complete:type:${type}`),
    hasGclid ? incr(env.STATS, "complete:from_google_ads") : Promise.resolve(),
    incrDay(env.STATS, day, hasGclid ? ["complete", "completeAds"] : ["complete"]),
  ]);

  return new Response(null, { status: 204 });
}

async function handleClick(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }
  if (!CLICK_TARGETS.includes(body?.target)) {
    return new Response("bad request", { status: 400 });
  }
  const target = body.target;
  const type = TYPE_KEYS.includes(body?.type) ? body.type : "unknown";
  const hasGclid = typeof body?.gclid === "string" && body.gclid.length > 0;
  const day = dayKey(new Date());

  const dayFields = [`${target}Click`];
  if (hasGclid) dayFields.push(`${target}ClickAds`);

  await Promise.all([
    incr(env.STATS, `click:${target}:total`),
    incr(env.STATS, `click:${target}:type:${type}`),
    hasGclid ? incr(env.STATS, `click:${target}:from_google_ads`) : Promise.resolve(),
    incrDay(env.STATS, day, dayFields),
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
  for (let i = DAYS_SHOWN - 1; i >= 0; i--) {
    days.push(dayKey(new Date(now.getTime() - i * 24 * 60 * 60 * 1000)));
  }

  const [
    completeTotal,
    completeAds,
    noteClicks,
    noteClicksAds,
    shareClicks,
    completeTypes,
    noteClickTypes,
    buckets,
  ] = await Promise.all([
    env.STATS.get("complete:total"),
    env.STATS.get("complete:from_google_ads"),
    env.STATS.get("click:note:total"),
    env.STATS.get("click:note:from_google_ads"),
    env.STATS.get("click:share:total"),
    Promise.all(TYPE_KEYS.map((t) => env.STATS.get(`complete:type:${t}`))),
    Promise.all(TYPE_KEYS.map((t) => env.STATS.get(`click:note:type:${t}`))),
    Promise.all(days.map((d) => readDay(env.STATS, d))),
  ]);

  const completed = num(completeTotal);
  const noteClicked = num(noteClicks);
  const completedAds = num(completeAds);
  const noteClickedAds = num(noteClicksAds);

  const dayRows = days
    .map((d, i) => {
      const b = buckets[i];
      const c = num(b.complete);
      const ca = num(b.completeAds);
      const nc = num(b.noteClick);
      const dim = c === 0 && nc === 0 ? ' style="color:#bbb"' : "";
      return `<tr${dim}>
        <td style="padding:6px 0">${d}</td>
        <td style="padding:6px 0;text-align:right;font-weight:600">${c}</td>
        <td style="padding:6px 0;text-align:right;color:#888">${ca}</td>
        <td style="padding:6px 0;text-align:right;font-weight:600">${nc}</td>
      </tr>`;
    })
    .join("");

  const typeRows = TYPE_KEYS.map((t, i) => {
    const c = num(completeTypes[i]);
    const nc = num(noteClickTypes[i]);
    return `<tr>
      <td style="padding:6px 0;color:#666">${TYPE_LABELS[t]}</td>
      <td style="padding:6px 0;text-align:right;font-weight:600">${c}</td>
      <td style="padding:6px 0;text-align:right">${nc}</td>
      <td style="padding:6px 0;text-align:right;color:#888">${rate(nc, c)}</td>
    </tr>`;
  }).join("");

  const html = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>診断 利用状況</title>
<meta name="robots" content="noindex">
<style>
  body{font-family:-apple-system,"Hiragino Kaku Gothic ProN",sans-serif;max-width:560px;margin:40px auto;padding:0 20px;color:#222}
  h1{font-size:20px}
  h2{font-size:14px;color:#666;margin-top:32px}
  table{width:100%;border-collapse:collapse;font-size:14px}
  tr{border-bottom:1px solid #eee}
  th{font-size:12px;color:#999;font-weight:400;text-align:right;padding-bottom:6px}
  th:first-child{text-align:left}
  .funnel{list-style:none;padding:0;margin:16px 0}
  .funnel li{padding:10px 0;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:baseline}
  .funnel .n{font-size:18px;font-weight:600}
  .funnel .r{font-size:12px;color:#888;margin-left:10px}
  .note{font-size:12px;color:#999;line-height:1.7;margin-top:24px}
</style></head>
<body>
<h1>AI時代の対応力診断 - 利用状況</h1>

<h2>ファネル(累計)</h2>
<ul class="funnel">
  <li><span>診断を完了した</span><span><span class="n">${completed}</span><span class="r">うちGoogle広告経由 ${completedAds}</span></span></li>
  <li><span>note記事(980円)へ遷移した</span><span><span class="n">${noteClicked}</span><span class="r">完了の ${rate(noteClicked, completed)} / うち広告経由 ${noteClickedAds}</span></span></li>
  <li><span>購入した</span><span><span class="n" style="color:#bbb">-</span><span class="r">noteに自動取得の手段がないため手元で確認</span></span></li>
  <li><span>Xでシェアした</span><span><span class="n">${num(shareClicks)}</span><span class="r">完了の ${rate(num(shareClicks), completed)}</span></span></li>
</ul>

<h2>直近${DAYS_SHOWN}日(JST)</h2>
<table>
  <tr><th>日付</th><th>完了</th><th>うち広告</th><th>note遷移</th></tr>
  ${dayRows}
</table>

<h2>タイプ別(累計)</h2>
<table>
  <tr><th>タイプ</th><th>完了</th><th>note遷移</th><th>遷移率</th></tr>
  ${typeRows}
</table>

<p class="note">
日別の数値は2026-08-17の計測方式変更(1日1キーのJSON化・日付の区切りをJSTに統一)以降のぶんです。累計の完了数はそれ以前から引き継いでいます。<br>
note遷移は1回の診断につき最大1件までしか数えません(同じ人の連打で率が100%を超えないようにするため)。
</p>
</body></html>`;

  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/complete" && request.method === "POST") {
      return handleComplete(request, env);
    }
    if (url.pathname === "/api/click" && request.method === "POST") {
      return handleClick(request, env);
    }
    if (url.pathname === "/stats" && request.method === "GET") {
      return handleStats(request, env);
    }

    return env.ASSETS.fetch(request);
  },
};
