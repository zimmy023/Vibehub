// VibeHub API - runs on Cloudflare Workers (free plan) with D1 (free SQLite database).
const MAX_CODE = 200 * 1024;   // max game size
const MAX_PENDING = 50;        // max requests waiting in the queue
const SUBMITS_PER_HOUR = 3;    // per IP
const enc = new TextEncoder();

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff', ...headers } });
const err = (msg, status) => json({ error: msg }, status);
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const newId = () => [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2, '0')).join('');

// ---- stateless admin sessions: cookie = "<expiry>.<hmac(expiry)>", signed with the admin password ----
async function sign(env, text) {
  const key = await crypto.subtle.importKey('raw', enc.encode(env.ADMIN_PASSWORD), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(text));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function safeEq(env, a, b) { // compare via HMACs so timing leaks nothing
  return (await sign(env, 'cmp:' + a)) === (await sign(env, 'cmp:' + b));
}
async function isAdmin(req, env) {
  const m = (req.headers.get('Cookie') || '').match(/(?:^|; )vh_session=([^;]*)/);
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEq(env, sig, await sign(env, exp));
}

// ---- rate limiting stored in D1 (a blocked attempt costs only a read, no write) ----
async function limited(env, key, max, windowMs) {
  const since = Date.now() - windowMs;
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM rl WHERE key = ? AND at > ?').bind(key, since).first();
  if (row.n >= max) return true;
  await env.DB.prepare('INSERT INTO rl (key, at) VALUES (?, ?)').bind(key, Date.now()).run();
  if (Math.random() < 0.05) await env.DB.prepare('DELETE FROM rl WHERE at < ?').bind(Date.now() - 86400e3).run();
  return false;
}

const isOpen = async env => (await env.DB.prepare("SELECT v FROM settings WHERE k = 'open'").first())?.v !== '0';
const out = r => ({ id: r.id, title: r.title, author: r.author, desc: r.blurb, at: r.at, ...(r.code !== undefined ? { code: r.code } : {}) });

async function readBody(req) {
  const text = await req.text();
  if (text.length > MAX_CODE + 10240) throw new Error('Too big');
  try { return JSON.parse(text || '{}'); } catch { throw new Error('Bad request'); }
}
function parseGame(b) {
  const g = { title: clean(b.title, 60), author: clean(b.author, 40) || 'anon', blurb: clean(b.desc, 140), code: String(b.code ?? '') };
  if (!g.title || !g.code.trim() || enc.encode(g.code).length > MAX_CODE) return null;
  return g;
}

export default {
  async fetch(req, env) {
    if (!env.ADMIN_PASSWORD) return err('Server not set up: missing ADMIN_PASSWORD secret.', 500);
    const url = new URL(req.url), p = url.pathname, m = req.method;
    const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
    try {
      let x;
      if (m === 'GET' && p === '/api/games') {
        const { results } = await env.DB.prepare('SELECT id, title, author, blurb, at FROM games ORDER BY at DESC').all();
        return json(results.map(out));
      }
      if (m === 'GET' && (x = p.match(/^\/api\/games\/(\w+)$/))) {
        const g = await env.DB.prepare('SELECT * FROM games WHERE id = ?').bind(x[1]).first();
        return g ? json(out(g)) : err('Not found', 404);
      }
      if (m === 'GET' && p === '/api/settings') return json({ open: await isOpen(env), admin: await isAdmin(req, env) });

      if (m === 'POST' && p === '/api/requests') {
        if (!(await isOpen(env))) return err('Submissions are closed right now.', 403);
        const b = await readBody(req);
        if (b.website) return json({ ok: true }); // honeypot: bots fill this in
        const g = parseGame(b);
        if (!g) return err('Need a title and game code (max 200 KB).', 400);
        const pending = await env.DB.prepare('SELECT COUNT(*) AS n FROM requests').first();
        if (pending.n >= MAX_PENDING) return err('The queue is full. Try again later.', 429);
        if (await limited(env, 'sub:' + ip, SUBMITS_PER_HOUR, 3600e3)) return err(`Limit: ${SUBMITS_PER_HOUR} submissions per hour.`, 429);
        await env.DB.prepare('INSERT INTO requests (id, title, author, blurb, code, at) VALUES (?,?,?,?,?,?)').bind(newId(), g.title, g.author, g.blurb, g.code, Date.now()).run();
        return json({ ok: true });
      }

      if (m === 'POST' && p === '/api/admin/login') {
        if (await limited(env, 'login:' + ip, 10, 15 * 60e3)) return err('Too many attempts.', 429);
        const b = await readBody(req);
        if (!(await safeEq(env, String(b.password || ''), env.ADMIN_PASSWORD))) return err('Wrong password.', 401);
        const exp = String(Date.now() + 7 * 86400e3);
        return json({ ok: true }, 200, { 'Set-Cookie': `vh_session=${exp}.${await sign(env, exp)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800` });
      }

      if (!p.startsWith('/api/admin/')) return err('Not found', 404);
      if (!(await isAdmin(req, env))) return err('Admin only.', 401);

      if (m === 'POST' && p === '/api/admin/logout') return json({ ok: true }, 200, { 'Set-Cookie': 'vh_session=; Max-Age=0; Path=/' });
      if (m === 'GET' && p === '/api/admin/requests') {
        const { results } = await env.DB.prepare('SELECT * FROM requests ORDER BY at').all();
        return json(results.map(out));
      }
      if (m === 'POST' && p === '/api/admin/games') {
        const g = parseGame(await readBody(req));
        if (!g) return err('Need a title and game code (max 200 KB).', 400);
        await env.DB.prepare('INSERT INTO games (id, title, author, blurb, code, at) VALUES (?,?,?,?,?,?)').bind(newId(), g.title, g.author, g.blurb, g.code, Date.now()).run();
        return json({ ok: true });
      }
      if (m === 'POST' && p === '/api/admin/settings') {
        const b = await readBody(req);
        await env.DB.prepare("INSERT INTO settings (k, v) VALUES ('open', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(b.open ? '1' : '0').run();
        return json({ open: !!b.open });
      }
      if (m === 'POST' && (x = p.match(/^\/api\/admin\/requests\/(\w+)\/approve$/))) {
        const r = await env.DB.prepare('SELECT * FROM requests WHERE id = ?').bind(x[1]).first();
        if (!r) return err('Not found', 404);
        await env.DB.batch([
          env.DB.prepare('INSERT INTO games (id, title, author, blurb, code, at) VALUES (?,?,?,?,?,?)').bind(r.id, r.title, r.author, r.blurb, r.code, Date.now()),
          env.DB.prepare('DELETE FROM requests WHERE id = ?').bind(r.id),
        ]);
        return json({ ok: true });
      }
      if (m === 'DELETE' && (x = p.match(/^\/api\/admin\/requests\/(\w+)$/))) {
        await env.DB.prepare('DELETE FROM requests WHERE id = ?').bind(x[1]).run();
        return json({ ok: true });
      }
      if (m === 'DELETE' && (x = p.match(/^\/api\/admin\/games\/(\w+)$/))) {
        await env.DB.prepare('DELETE FROM games WHERE id = ?').bind(x[1]).run();
        return json({ ok: true });
      }
      return err('Not found', 404);
    } catch (e) {
      return err(e.message === 'Too big' || e.message === 'Bad request' ? e.message : 'Server error. If the free daily limit was hit, it resets at midnight UTC.', 400);
    }
  },
};
