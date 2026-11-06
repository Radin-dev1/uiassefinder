// Image search through official search APIs (no scraping).
// Each "source" is a site filter applied to the query.

export const SOURCES = {
  pinterest: { label: 'Pinterest', site: 'pinterest.com', url: (q) => `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(q)}` },
  dribbble: { label: 'Dribbble', site: 'dribbble.com', url: (q) => `https://dribbble.com/search/${encodeURIComponent(q)}` },
  behance: { label: 'Behance', site: 'behance.net', url: (q) => `https://www.behance.net/search/projects?search=${encodeURIComponent(q)}` },
  artstation: { label: 'ArtStation', site: 'artstation.com', url: (q) => `https://www.artstation.com/search?query=${encodeURIComponent(q)}` },
  devforum: { label: 'Roblox DevForum', site: 'devforum.roblox.com', url: (q) => `https://devforum.roblox.com/search?q=${encodeURIComponent(q)}` },
  web: { label: 'Whole web', site: null, url: (q) => `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(q)}` },
};

export const SEARCH_PROVIDERS = {
  serper: { label: 'Serper.dev (Google Images)', signup: 'https://serper.dev' },
  brave: { label: 'Brave Search API', signup: 'https://brave.com/search/api/' },
  serpapi: { label: 'SerpAPI (Google Images)', signup: 'https://serpapi.com' },
  none: { label: 'No search key (just give me links)', signup: null },
};

function hostOf(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

async function serper(key, q, num) {
  const res = await fetch('https://google.serper.dev/images', {
    method: 'POST',
    headers: { 'X-API-KEY': key, 'content-type': 'application/json' },
    body: JSON.stringify({ q, num }),
  });
  if (!res.ok) throw new Error(`Serper ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return (j.images || []).map((r) => ({
    title: r.title,
    image: r.imageUrl,
    thumb: r.thumbnailUrl || r.imageUrl,
    page: r.link,
    width: r.imageWidth,
    height: r.imageHeight,
  }));
}

async function brave(key, q, num) {
  const u = `https://api.search.brave.com/res/v1/images/search?q=${encodeURIComponent(q)}&count=${Math.min(num, 100)}&safesearch=strict`;
  const res = await fetch(u, { headers: { 'X-Subscription-Token': key, accept: 'application/json' } });
  if (!res.ok) throw new Error(`Brave ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return (j.results || []).map((r) => ({
    title: r.title,
    image: r.properties?.url || r.thumbnail?.src,
    thumb: r.thumbnail?.src || r.properties?.url,
    page: r.url,
    width: r.properties?.width,
    height: r.properties?.height,
  }));
}

async function serpapi(key, q, num) {
  const u = `https://serpapi.com/search.json?engine=google_images&q=${encodeURIComponent(q)}&api_key=${encodeURIComponent(key)}`;
  const res = await fetch(u);
  if (!res.ok) throw new Error(`SerpAPI ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  if (j.error) throw new Error(`SerpAPI: ${j.error}`);
  return (j.images_results || []).slice(0, num).map((r) => ({
    title: r.title,
    image: r.original || r.thumbnail,
    thumb: r.thumbnail || r.original,
    page: r.link,
    width: r.original_width,
    height: r.original_height,
  }));
}

const RUNNERS = { serper, brave, serpapi };

/**
 * Runs every (source x query) combination and merges results.
 * Returns { results, errors }.
 */
export async function searchImages({ provider, key, queries, sources, perQuery = 10 }) {
  const run = RUNNERS[provider];
  if (!run) return { results: [], errors: [] };
  if (!key) throw new Error('Add your search API key in Settings (or pick "No search key").');

  const jobs = [];
  for (const s of sources) {
    const src = SOURCES[s];
    if (!src) continue;
    for (const q of queries) {
      const full = src.site ? `${q} site:${src.site}` : q;
      jobs.push(
        run(key, full, perQuery).then((rows) => rows.map((r) => ({ ...r, source: s, query: q })))
      );
    }
  }

  const settled = await Promise.allSettled(jobs);
  const errors = [];
  const seen = new Set();
  const results = [];
  for (const s of settled) {
    if (s.status === 'rejected') {
      errors.push(String(s.reason?.message || s.reason));
      continue;
    }
    for (const r of s.value) {
      if (!r.image) continue;
      const k = r.image.split('?')[0];
      if (seen.has(k)) continue;
      seen.add(k);
      results.push({ ...r, domain: hostOf(r.page || r.image) });
    }
  }
  return { results, errors: [...new Set(errors)] };
}

export function sourceLinks(queries, sources) {
  return sources
    .filter((s) => SOURCES[s])
    .map((s) => ({
      source: s,
      label: SOURCES[s].label,
      links: queries.map((q) => ({ query: q, url: SOURCES[s].url(q) })),
    }));
}
