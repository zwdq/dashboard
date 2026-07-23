// Dashboard API — 所有 token 从环境变量读取，前端不含任何密钥

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "*" },
  });
}

function checkAuth(request, env) {
  const token = (request.headers.get("Authorization") || "").replace("Bearer ", "");
  return token === (env.ACCESS_PASSWORD || "shaduanduan123");
}

// ── Cloudflare Pages 项目 ──
async function getCFPages(env) {
  const token = env.CF_API_TOKEN;
  const account = env.CF_ACCOUNT_ID;
  if (!token || !account) return [];

  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/pages/projects`, {
    headers: { "Authorization": `Bearer ${token}` },
  });
  const d = await r.json();
  if (!d.success) return [];

  return (d.result || []).map(p => {
    const subdomain = p.subdomain ? p.subdomain.replace(/\.pages\.dev\.pages\.dev$/, '.pages.dev') : null;
    return {
      name: p.name,
      subdomain,
      domains: p.domains || [],
      deployments: p.deployments?.length || 0,
    };
  });
}

// ── 外部项目 ──
function getExternalSites() {
  return [{
    name: "qdii-quota",
    subdomain: "https://zwdq.github.io/qdii-quota/fund-quota.html",
    domains: [],
    deployments: 0,
  }];
}

// ── Cloudflare D1 + Workers 实时用量 ──
async function getCFUsage(env) {
  const token = env.CF_API_TOKEN;
  const account = env.CF_ACCOUNT_ID;
  if (!token || !account) return {};

  const fromISO = `${new Date().toISOString().slice(0, 10)}T00:00:00Z`;
  let analytics = { workersRequests: 0, workersErrors: 0, d1RowsRead: 0, d1RowsWritten: 0, d1Count: 0, workersCount: 0 };

  try {
    const gqlResp = await fetch(`https://api.cloudflare.com/client/v4/graphql`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `{ viewer { accounts(filter: {accountTag: "${account}"}) {
          workersInvocationsAdaptive(limit: 50, filter: {datetime_gt: "${fromISO}"}) { sum { requests errors } }
          d1QueriesAdaptiveGroups(limit: 50, filter: {datetime_gt: "${fromISO}"}) { sum { rowsRead rowsWritten } dimensions { databaseId } }
        } } }`,
      }),
    });
    const acc = (await gqlResp.json())?.data?.viewer?.accounts?.[0];
    if (acc) {
      const w = acc.workersInvocationsAdaptive || [];
      analytics.workersRequests = w.reduce((s, i) => s + (i.sum.requests || 0), 0);
      analytics.workersErrors = w.reduce((s, i) => s + (i.sum.errors || 0), 0);
      const d = acc.d1QueriesAdaptiveGroups || [];
      analytics.d1RowsRead = d.reduce((s, i) => s + (i.sum.rowsRead || 0), 0);
      analytics.d1RowsWritten = d.reduce((s, i) => s + (i.sum.rowsWritten || 0), 0);
      analytics.d1Count = new Set(d.map(i => i.dimensions.databaseId)).size;
    }
  } catch {}

  try {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts`, {
      headers: { "Authorization": `Bearer ${token}` },
    });
    analytics.workersCount = ((await r.json()).result || []).length;
  } catch {}

  return analytics;
}

// ── 腾讯云轻量服务器 ──
function getTencentLighthouse() {
  return {
    configured: true, provider: "tencent",
    ip: "152.136.152.43", privateIp: "10.2.20.9",
    cpu: 2, memory: 4, os: "Ubuntu 22.04 LTS",
    bandwidth: "6 Mbps", disk: "70 GB SSD",
    expireDate: "2028-06-12", created: "2024-06-12",
  };
}

// ── 阿里云 ECS ──
function getAliyunECS() {
  return {
    configured: true, provider: "aliyun",
    ip: "123.57.225.162", privateIp: "172.22.15.248",
    cpu: 2, memory: 2, os: "Ubuntu 22.04 64位",
    bandwidth: "3 Mbps", disk: "ESSD Entry 40GB",
    expireDate: "2027-01-12", created: "2024-01-01",
  };
}

// ── 皮皮虾 AI (Psydo) — token 缓存 + refresh 轮换 ──
let _psydoTokenCache = null;

async function getPsydoAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  // 内存缓存
  if (_psydoTokenCache && _psydoTokenCache.accessExp - now > 300) {
    return _psydoTokenCache.accessToken;
  }
  // KV 缓存
  let cached = null;
  try { const raw = await env.DASH_KV?.get("psydo_token"); if (raw) cached = JSON.parse(raw); } catch {}
  if (cached && cached.accessExp - now > 300) {
    _psydoTokenCache = cached;
    return cached.accessToken;
  }
  // refresh 续期
  if (cached?.refreshToken) {
    try {
      const r = await fetch("https://api.psydo.top/api/v1/auth/refresh", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: cached.refreshToken }),
      });
      if (r.ok) {
        const d = (await r.json())?.data;
        if (d?.access_token) {
          const t = { accessToken: d.access_token, refreshToken: d.refresh_token, accessExp: now + (d.expires_in || 86400) };
          _psydoTokenCache = t;
          try { await env.DASH_KV?.put("psydo_token", JSON.stringify(t)); } catch {}
          return t.accessToken;
        }
      }
    } catch {}
  }
  // 密码登录
  const r = await fetch("https://api.psydo.top/api/v1/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: env.PSYDO_EMAIL, password: env.PSYDO_PASSWORD }),
  });
  if (!r.ok) return null;
  const d = (await r.json())?.data;
  if (!d?.access_token) return null;
  const t = { accessToken: d.access_token, refreshToken: d.refresh_token, accessExp: now + (d.expires_in || 86400) };
  _psydoTokenCache = t;
  try { await env.DASH_KV?.put("psydo_token", JSON.stringify(t)); } catch {}
  return t.accessToken;
}

async function getPsydoBalance(env) {
  if (!env.PSYDO_EMAIL || !env.PSYDO_PASSWORD) return null;
  try {
    const accessToken = await getPsydoAccessToken(env);
    if (!accessToken) return { configured: true, status: "error", error: "auth failed" };

    const sub = (await (await fetch("https://api.psydo.top/api/v1/subscriptions", {
      headers: { "Authorization": `Bearer ${accessToken}` },
    })).json())?.data?.[0];
    if (!sub) return { configured: true, status: "error", error: "no subscription" };

    let textUsage = 0, imageUsage = 0;
    try {
      const items = (await (await fetch("https://api.psydo.top/api/v1/usage?page=1&page_size=100", {
        headers: { "Authorization": `Bearer ${accessToken}` },
      })).json())?.data?.items || [];
      for (const i of items) {
        if (i.image_count > 0 || i.billing_mode === "image") imageUsage += i.actual_cost || 0;
        else textUsage += i.actual_cost || 0;
      }
    } catch {}

    const limit = sub.monthly_limit_usd || 0;
    const used = sub.monthly_usage_usd || 0;
    return {
      configured: true, status: "ok",
      planName: sub.plan_name || "轻享月卡",
      monthlyLimit: limit, monthlyUsed: used, monthlyRemain: limit - used,
      dailyUsed: sub.daily_usage_usd || 0, weeklyUsed: sub.weekly_usage_usd || 0,
      textUsage, imageUsage,
      expiresAt: sub.expires_at, overagePolicy: sub.overage_policy,
    };
  } catch (e) {
    return { configured: true, status: "error", error: e.message };
  }
}

// ── 天气 ──
const WEATHER_CODES = {
  0: "☀️ 晴", 1: "🌤️ 多云", 2: "⛅ 阴", 3: "☁️ 阴",
  45: "🌫️ 雾", 48: "🌫️ 冻雾",
  51: "🌦️ 小毛毛雨", 53: "🌦️ 毛毛雨", 55: "🌧️ 大毛毛雨",
  56: "🌧️ 冻毛毛雨", 57: "🌧️ 冻雨",
  61: "🌧️ 小雨", 63: "🌧️ 中雨", 65: "🌧️ 大雨",
  66: "🌧️ 冻雨", 67: "🌧️ 大冻雨",
  71: "🌨️ 小雪", 73: "🌨️ 中雪", 75: "❄️ 大雪", 77: "🌨️ 雪粒",
  80: "🌧️ 阵雨", 81: "🌧️ 中阵雨", 82: "⛈️ 大阵雨",
  85: "🌨️ 阵雪", 86: "❄️ 大阵雪",
  95: "⛈️ 雷暴", 96: "⛈️ 雷暴+冰雹", 99: "⛈️ 大雷暴+冰雹",
};

async function getWeather() {
  try {
    const r = await fetch(
      "https://api.open-meteo.com/v1/forecast?latitude=39.9042&longitude=116.4074&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,precipitation&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,weather_code&timezone=Asia/Shanghai&forecast_days=7",
      { signal: AbortSignal.timeout(4000) }
    );
    const d = await r.json();
    const c = d.current || {};
    const daily = d.daily || {};
    const code = c.weather_code ?? 0;
    const forecast = (daily.time || []).map((date, i) => ({
      date, tempMax: daily.temperature_2m_max?.[i], tempMin: daily.temperature_2m_min?.[i],
      rainProb: daily.precipitation_probability_max?.[i],
      weatherText: WEATHER_CODES[daily.weather_code?.[i]] || "❓",
    }));
    return {
      temp: c.temperature_2m, humidity: c.relative_humidity_2m, windSpeed: c.wind_speed_10m,
      weatherCode: code, weatherText: WEATHER_CODES[code] || "❓ 未知",
      tempMax: daily.temperature_2m_max?.[0], tempMin: daily.temperature_2m_min?.[0],
      rainProbability: daily.precipitation_probability_max?.[0],
      location: "北京西城区", forecast,
    };
  } catch {
    return { error: "天气获取失败", location: "北京西城区" };
  }
}

// ── 健康检查 ──
async function checkHealth(url) {
  try {
    const start = Date.now();
    const r = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(3000) });
    return { url, status: r.status, ok: r.ok, ms: Date.now() - start };
  } catch {
    return { url, status: 0, ok: false, ms: 0 };
  }
}

// ── 路由 ──
export async function onRequest(context) {
  const { request, env } = context;
  const path = new URL(request.url).pathname.replace("/api", "") || "/";

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "*" } });
  }
  if (!checkAuth(request, env)) return json({ success: false, error: "未授权" }, 401);

  try {
    if (path === "/status" && request.method === "GET") {
      // 边缘缓存 3 分钟
      const cache = caches.default;
      const cacheUrl = new Request("https://dash-cache.local/status", request);
      const cached = await cache.match(cacheUrl);
      if (cached) return json({ success: true, data: await cached.json(), cached: true });

      const [cfPages, cfUsage, tencent, aliyun, psydo, weather] = await Promise.all([
        getCFPages(env), getCFUsage(env), getTencentLighthouse(), getAliyunECS(),
        getPsydoBalance(env), getWeather(),
      ]);
      const pages = [...cfPages, ...getExternalSites()];

      const health = await Promise.all(
        pages.filter(p => p.subdomain).map(async p => ({
          name: p.name,
          ...await checkHealth(p.subdomain.startsWith("http") ? p.subdomain : `https://${p.subdomain}`),
        }))
      );

      const result = { pages, health, cfUsage, tencent, aliyun, psydo, weather, timestamp: new Date().toISOString() };
      await cache.put(cacheUrl, new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=180" },
      }));
      return json({ success: true, data: result, cached: false });
    }

    return json({ success: false, error: "未找到路由: " + path }, 404);
  } catch (e) {
    return json({ success: false, error: e.message }, 500);
  }
}
