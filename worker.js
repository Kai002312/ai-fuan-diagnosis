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

// ファネルの上段。`complete`/`click` は元から別の受け口があるので、ここは訪問と開始だけ。
const TRACK_STEPS = ["visit", "start"];

/** 流入元が分からない訪問(直接・検索・リンク元不明)をまとめる先。 */
const DIRECT_SOURCE = "direct";
/** gclid が付いていた訪問。utm_source が何であってもこちらを優先する。 */
const ADS_SOURCE = "google_ads";
/** 流入元の一覧。読み出すときにキー名を総当たりしなくて済むよう、書き込み時に足しておく。 */
const SOURCES_KEY = "sources";

const DAYS_SHOWN = 14;

function dayKey(date) {
  // 広告の管理画面(JST)と突き合わせるので、日付の区切りもJSTに合わせる。
  return new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * URLの `utm_source` はいくらでも書き換えられるので、そのままキーにすると
 * 外からKVのキー空間を汚せてしまう。英数字と - _ だけに落とし、長さも切る。
 * (Proudlog の src/lib/stats.ts と同じ規則にしてある)
 */
function normalizeSource(value) {
  if (typeof value !== "string") return DIRECT_SOURCE;
  const cleaned = value.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 20);
  return cleaned || DIRECT_SOURCE;
}

/** 生の gclid / utm_source から流入元を決める。判定はここ1箇所だけに置く。 */
function resolveSource(gclid, source) {
  const fromAds = typeof gclid === "string" && gclid.length > 0;
  return { fromAds, source: fromAds ? ADS_SOURCE : normalizeSource(source) };
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

// 流入元別も日別と同じく1流入元1キーのJSONにまとめる。
// 指標ごとに別キーにすると /stats の読み出しが 指標数×流入元数 のsubrequestになり、
// Workersの1リクエストあたりの上限に近づくため。
async function incrSrc(kv, source, fields) {
  const key = `src:${source}`;
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

async function readSrc(kv, source) {
  try {
    return JSON.parse((await kv.get(`src:${source}`)) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

async function readSources(kv) {
  try {
    const list = JSON.parse((await kv.get(SOURCES_KEY)) ?? "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** 見たことのある流入元を控えておく。/stats がキーを総当たりしなくて済むようにするため。 */
async function rememberSource(kv, source) {
  const list = await readSources(kv);
  if (list.includes(source)) return;
  // 上限を切っておく。utm_source は外から自由に付けられるので、際限なく増えうる。
  if (list.length >= 30) return;
  list.push(source);
  await kv.put(SOURCES_KEY, JSON.stringify(list));
}

function num(value) {
  return parseInt(value, 10) || 0;
}

function rate(numerator, denominator) {
  if (!denominator) return "-";
  return ((numerator / denominator) * 100).toFixed(1) + "%";
}

/**
 * ファネル上段(訪問・診断開始)の受け口。
 *
 * これが無かったせいで「完了0件」が【広告のクリックがページに着いていない】のか
 * 【着いた上で離脱した】のか切り分けられなかった。分母を持つのがこの受け口の目的。
 * 1セッション1回までの重複排除はクライアント側(sessionStorage)で行う。
 */
async function handleTrack(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }
  if (!TRACK_STEPS.includes(body?.step)) {
    return new Response("bad request", { status: 400 });
  }
  const step = body.step;
  const { fromAds, source } = resolveSource(body?.gclid, body?.source);
  const day = dayKey(new Date());

  const dayFields = [step];
  if (fromAds) dayFields.push(`${step}Ads`);

  await Promise.all([
    incr(env.STATS, `${step}:total`),
    fromAds ? incr(env.STATS, `${step}:from_google_ads`) : Promise.resolve(),
    incrDay(env.STATS, day, dayFields),
    incrSrc(env.STATS, source, [step]),
    rememberSource(env.STATS, source),
  ]);

  return new Response(null, { status: 204 });
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
  const { source } = resolveSource(body?.gclid, body?.source);
  const day = dayKey(new Date());

  await Promise.all([
    incr(env.STATS, "complete:total"),
    incr(env.STATS, `complete:type:${type}`),
    hasGclid ? incr(env.STATS, "complete:from_google_ads") : Promise.resolve(),
    incrDay(env.STATS, day, hasGclid ? ["complete", "completeAds"] : ["complete"]),
    incrSrc(env.STATS, source, ["complete"]),
    rememberSource(env.STATS, source),
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
  const { source } = resolveSource(body?.gclid, body?.source);
  const day = dayKey(new Date());

  const dayFields = [`${target}Click`];
  if (hasGclid) dayFields.push(`${target}ClickAds`);

  await Promise.all([
    incr(env.STATS, `click:${target}:total`),
    incr(env.STATS, `click:${target}:type:${type}`),
    hasGclid ? incr(env.STATS, `click:${target}:from_google_ads`) : Promise.resolve(),
    incrDay(env.STATS, day, dayFields),
    incrSrc(env.STATS, source, [`${target}Click`]),
    rememberSource(env.STATS, source),
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
    visitTotal,
    visitAds,
    startTotal,
    startAds,
    completeTotal,
    completeAds,
    noteClicks,
    noteClicksAds,
    shareClicks,
    completeTypes,
    noteClickTypes,
    buckets,
    sources,
  ] = await Promise.all([
    env.STATS.get("visit:total"),
    env.STATS.get("visit:from_google_ads"),
    env.STATS.get("start:total"),
    env.STATS.get("start:from_google_ads"),
    env.STATS.get("complete:total"),
    env.STATS.get("complete:from_google_ads"),
    env.STATS.get("click:note:total"),
    env.STATS.get("click:note:from_google_ads"),
    env.STATS.get("click:share:total"),
    Promise.all(TYPE_KEYS.map((t) => env.STATS.get(`complete:type:${t}`))),
    Promise.all(TYPE_KEYS.map((t) => env.STATS.get(`click:note:type:${t}`))),
    Promise.all(days.map((d) => readDay(env.STATS, d))),
    readSources(env.STATS),
  ]);

  const srcBuckets = await Promise.all(sources.map((s) => readSrc(env.STATS, s)));

  const visited = num(visitTotal);
  const started = num(startTotal);
  const completed = num(completeTotal);
  const noteClicked = num(noteClicks);
  const visitedAds = num(visitAds);
  const startedAds = num(startAds);
  const completedAds = num(completeAds);
  const noteClickedAds = num(noteClicksAds);

  const srcRows = sources.length
    ? sources
        .map((s, i) => {
          const b = srcBuckets[i];
          return `<tr>
        <td style="padding:6px 0;color:#666">${s === ADS_SOURCE ? "Google広告" : s === DIRECT_SOURCE ? "直接・不明" : s}</td>
        <td style="padding:6px 0;text-align:right;font-weight:600">${num(b.visit)}</td>
        <td style="padding:6px 0;text-align:right">${num(b.start)}</td>
        <td style="padding:6px 0;text-align:right">${num(b.complete)}</td>
        <td style="padding:6px 0;text-align:right;color:#888">${rate(num(b.complete), num(b.visit))}</td>
      </tr>`;
        })
        .join("")
    : `<tr><td colspan="5" style="padding:10px 0;color:#bbb">まだ記録がありません</td></tr>`;

  const dayRows = days
    .map((d, i) => {
      const b = buckets[i];
      const v = num(b.visit);
      const st = num(b.start);
      const c = num(b.complete);
      const ca = num(b.completeAds);
      const nc = num(b.noteClick);
      const dim = v === 0 && c === 0 && nc === 0 ? ' style="color:#bbb"' : "";
      return `<tr${dim}>
        <td style="padding:6px 0">${d}</td>
        <td style="padding:6px 0;text-align:right;font-weight:600">${v}</td>
        <td style="padding:6px 0;text-align:right">${st}</td>
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
  <li><span>ページに来た</span><span><span class="n">${visited}</span><span class="r">うちGoogle広告経由 ${visitedAds}</span></span></li>
  <li><span>診断をはじめた</span><span><span class="n">${started}</span><span class="r">訪問の ${rate(started, visited)} / うち広告経由 ${startedAds}</span></span></li>
  <li><span>診断を完了した</span><span><span class="n">${completed}</span><span class="r">開始の ${rate(completed, started)} / うち広告経由 ${completedAds}</span></span></li>
  <li><span>note記事(980円)へ遷移した</span><span><span class="n">${noteClicked}</span><span class="r">完了の ${rate(noteClicked, completed)} / うち広告経由 ${noteClickedAds}</span></span></li>
  <li><span>購入した</span><span><span class="n" style="color:#bbb">-</span><span class="r">noteに自動取得の手段がないため手元で確認</span></span></li>
  <li><span>Xでシェアした</span><span><span class="n">${num(shareClicks)}</span><span class="r">完了の ${rate(num(shareClicks), completed)}</span></span></li>
</ul>

<h2>流入元別(累計)</h2>
<table>
  <tr><th>流入元</th><th>訪問</th><th>開始</th><th>完了</th><th>完了率</th></tr>
  ${srcRows}
</table>

<h2>直近${DAYS_SHOWN}日(JST)</h2>
<table>
  <tr><th>日付</th><th>訪問</th><th>開始</th><th>完了</th><th>うち広告</th><th>note遷移</th></tr>
  ${dayRows}
</table>

<h2>タイプ別(累計)</h2>
<table>
  <tr><th>タイプ</th><th>完了</th><th>note遷移</th><th>遷移率</th></tr>
  ${typeRows}
</table>

<p class="note">
日別の数値は2026-08-17の計測方式変更(1日1キーのJSON化・日付の区切りをJSTに統一)以降のぶんです。累計の完了数はそれ以前から引き継いでいます。<br>
<strong>訪問・開始の計測は2026-08-18に追加したものです。それ以前の完了数には対応する訪問数がないため、初日は完了率が100%を超えて見えることがあります。</strong><br>
訪問・開始は1セッションにつき1回だけ数えます(同じ人の再読み込みで分母が膨らまないようにするため)。note遷移も1回の診断につき最大1件までです。<br>
流入元は gclid が付いていれば Google広告、次に <code>utm_source</code>、どちらも無ければ「直接・不明」として記録します。
</p>
</body></html>`;

  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

// 純粋な関数だけテストから触れるようにしておく。
// Workersランタイムは default export だけを見るので、これがあっても動作は変わらない。
// (このマシンでは `wrangler dev` の workerd が起動しないため、ロジックはここ経由で検証している)
export { normalizeSource, resolveSource, dayKey };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/track" && request.method === "POST") {
      return handleTrack(request, env);
    }
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
