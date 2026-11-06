import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chatJson, listModels, PROVIDERS } from './lib/ai.js';
import { searchImages, sourceLinks, SOURCES, SEARCH_PROVIDERS } from './lib/search.js';
import { ExampleLibrary } from './lib/examples.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 5177;
// Hosts (Render, Railway, Fly, Docker...) set PORT and need 0.0.0.0; locally stay on loopback.
const HOST = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
const EXAMPLES_DIR = path.resolve(process.env.EXAMPLES_DIR || path.join(__dirname, 'examples'));

const library = new ExampleLibrary(EXAMPLES_DIR);
const app = express();
app.use(express.json({ limit: '30mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/examples', express.static(EXAMPLES_DIR, { dotfiles: 'deny' }));

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    console.error(e);
    res.status(400).json({ error: e.message || String(e) });
  });

function parseDataUrl(dataUrl) {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(dataUrl || '');
  if (!m) return null;
  let mediaType = m[1].toLowerCase();
  if (mediaType === 'image/jpg') mediaType = 'image/jpeg';
  return { mediaType, data: m[2] };
}

async function fetchImage(url, maxBytes = 15 * 1024 * 1024) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) URLs');
  const res = await fetch(u, { headers: { 'user-agent': 'uiassefinder/1.0' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!type.startsWith('image/')) throw new Error('That URL is not an image');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error('Image too large');
  return { buf, type: type === 'image/jpg' ? 'image/jpeg' : type };
}

// ---------- config ----------
app.get('/api/config', (req, res) => {
  res.json({
    providers: PROVIDERS,
    searchProviders: SEARCH_PROVIDERS,
    sources: Object.fromEntries(Object.entries(SOURCES).map(([k, v]) => [k, { label: v.label }])),
    examplesDir: EXAMPLES_DIR,
  });
});

app.post('/api/models', wrap(async (req, res) => {
  res.json({ models: await listModels(req.body.ai) });
}));

// ---------- examples ----------
app.get('/api/examples', wrap(async (req, res) => {
  res.json({ items: await library.list(), dir: EXAMPLES_DIR });
}));

app.post('/api/examples/index', wrap(async (req, res) => {
  res.json(await library.index(req.body.ai));
}));

app.post('/api/examples/upload', wrap(async (req, res) => {
  const files = req.body.files || [];
  const saved = [];
  for (const f of files) {
    const img = parseDataUrl(f.dataUrl);
    if (!img) continue;
    saved.push(await library.saveBuffer(f.name || 'upload.png', Buffer.from(img.data, 'base64'), req.body.folder));
  }
  res.json({ saved });
}));

app.post('/api/examples/save-url', wrap(async (req, res) => {
  const { url, name, folder } = req.body;
  const { buf, type } = await fetchImage(url);
  const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' }[type] || '.png';
  const base = (name || 'web-asset').replace(/\.[a-z0-9]+$/i, '').slice(0, 60) + ext;
  res.json({ saved: await library.saveBuffer(base, buf, folder || 'from-web') });
}));

// ---------- main search ----------
app.post('/api/search', wrap(async (req, res) => {
  const { ai, search = {}, text = '', image, sources = ['pinterest'], rerank = true, includeExamples = true, perQuery = 10 } = req.body;
  const userImage = image ? parseDataUrl(image) : null;
  if (!text.trim() && !userImage) throw new Error('Type what you are looking for, drop an image, or both.');

  // 1) Understand what the user wants.
  const analysis = await chatJson(ai, {
    system:
      'You are a UI/UX art director helping a game (often Roblox) UI designer find reference assets and inspiration on Pinterest, Dribbble, Behance and the web.',
    prompt:
      (userImage ? 'The attached image is a reference of what the user wants (find similar UI).\n' : '') +
      (text.trim() ? `The user says: "${text.trim()}"\n` : '') +
      'Return JSON: {"description": "1-2 sentences of exactly what to look for (element type, style, colours, mood)", ' +
      '"tags": ["6-12 short lowercase tags"], ' +
      '"queries": ["3 to 5 short image-search queries (2-6 words each) that would find visually similar UI on Pinterest/Dribbble; vary them: one literal, one style-focused, one with \'ui\' or \'game ui\'"], ' +
      '"colors": ["up to 5 hex colours that define the look"]}',
    images: userImage ? [userImage] : [],
    maxTokens: 800,
  });
  analysis.queries = (analysis.queries || []).map(String).filter(Boolean).slice(0, 5);
  if (!analysis.queries.length && text.trim()) analysis.queries = [text.trim()];

  const out = { analysis, web: [], examples: [], links: sourceLinks(analysis.queries, sources), errors: [] };

  // 2) Web search + local examples in parallel.
  const webJob = (async () => {
    if (!search.provider || search.provider === 'none') return;
    const { results, errors } = await searchImages({
      provider: search.provider,
      key: search.key,
      queries: analysis.queries.slice(0, 3),
      sources,
      perQuery: Math.min(Math.max(Number(perQuery) || 10, 3), 30),
    });
    out.errors.push(...errors);
    out.web = results;
  })().catch((e) => out.errors.push(`Web search: ${e.message}`));

  const exJob = (async () => {
    if (!includeExamples) return;
    out.examples = await library.search(ai, analysis);
  })().catch((e) => out.errors.push(`Examples: ${e.message}`));

  await Promise.all([webJob, exJob]);

  // 3) Optional AI rerank of the web results by looking at the thumbnails.
  if (rerank && out.web.length) {
    try {
      out.web = await rerankWeb(ai, analysis, out.web, userImage);
    } catch (e) {
      out.errors.push(`Rerank skipped: ${e.message}`);
    }
  }

  res.json(out);
}));

async function rerankWeb(ai, analysis, results, userImage) {
  const MAX = 20;
  const head = results.slice(0, MAX);
  const thumbs = await Promise.all(
    head.map(async (r) => {
      try {
        const { buf, type } = await fetchImage(r.thumb, 2 * 1024 * 1024);
        if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(type)) return null;
        return { mediaType: type, data: buf.toString('base64') };
      } catch {
        return null;
      }
    })
  );
  const usable = head.map((r, i) => ({ r, img: thumbs[i] })).filter((x) => x.img);
  if (usable.length < 2) return results;

  const images = [...(userImage ? [userImage] : []), ...usable.map((x) => x.img)];
  const j = await chatJson(ai, {
    system: 'You judge how well candidate images match a UI reference request.',
    prompt:
      `Target: ${analysis.description}\n` +
      (userImage ? 'The FIRST image is the user\'s reference. ' : '') +
      `The next ${usable.length} images are candidates numbered 0..${usable.length - 1} in order` +
      `${usable.map((x, n) => `\n${n}: "${x.r.title || ''}" (${x.r.domain})`).join('')}\n` +
      'Score each candidate 0-100 for how useful it is as a UI asset/reference for the target (style + element type). ' +
      'Return JSON {"scores":[{"n":0,"score":80,"reason":"short"}]}.',
    images,
    maxTokens: 2000,
  });
  const byN = new Map((j.scores || []).map((s) => [Number(s.n), s]));
  const scored = usable.map((x, n) => ({ ...x.r, score: Number(byN.get(n)?.score) || 0, reason: byN.get(n)?.reason || '' }));
  scored.sort((a, b) => b.score - a.score);
  const scoredSet = new Set(usable.map((x) => x.r));
  return [...scored, ...results.filter((r) => !scoredSet.has(r))];
}

app.get('/healthz', (req, res) => res.send('ok'));

// On Vercel the app is imported as a serverless function instead of listening.
if (!process.env.VERCEL) {
  app.listen(PORT, HOST, () => {
    console.log(`\n  UI Asset Finder running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    console.log(`  Examples folder: ${EXAMPLES_DIR}\n`);
  });
}

export default app;
