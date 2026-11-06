// Your local "UI examples" folder. Each image gets described once by the AI
// (cached in examples/.index.json) so text or image queries can find it later.
import fs from 'node:fs/promises';
import path from 'node:path';
import { chatJson } from './ai.js';

const IMAGE_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const MAX_VISION_BYTES = 4.5 * 1024 * 1024;

export function mediaTypeFor(file) {
  return IMAGE_EXT[path.extname(file).toLowerCase()] || null;
}

async function walk(dir, base = dir) {
  const out = [];
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full, base)));
    else if (mediaTypeFor(e.name)) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

export class ExampleLibrary {
  constructor(dir) {
    this.dir = dir;
    this.indexPath = path.join(dir, '.index.json');
  }

  async loadIndex() {
    try {
      return JSON.parse(await fs.readFile(this.indexPath, 'utf8'));
    } catch {
      return {};
    }
  }

  async saveIndex(index) {
    await fs.writeFile(this.indexPath, JSON.stringify(index, null, 2));
  }

  /** All images with their (possibly stale/missing) index entry. */
  async list() {
    await fs.mkdir(this.dir, { recursive: true });
    const files = await walk(this.dir);
    const index = await this.loadIndex();
    const items = [];
    for (const f of files) {
      const st = await fs.stat(path.join(this.dir, f));
      const sig = `${st.size}-${Math.round(st.mtimeMs)}`;
      const entry = index[f];
      items.push({
        file: f,
        folder: f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '',
        size: st.size,
        indexed: !!entry && entry.sig === sig,
        description: entry?.description || '',
        tags: entry?.tags || [],
        sig,
      });
    }
    return items;
  }

  /** Describe every image that is new or changed. */
  async index(ai, { onProgress, concurrency = 3 } = {}) {
    const items = await this.list();
    const index = await this.loadIndex();
    // Drop entries for deleted files.
    const present = new Set(items.map((i) => i.file));
    for (const k of Object.keys(index)) if (!present.has(k)) delete index[k];

    const todo = items.filter((i) => !i.indexed);
    const errors = [];
    let done = 0;
    const queue = [...todo];
    const worker = async () => {
      while (queue.length) {
        const item = queue.shift();
        try {
          if (item.size > MAX_VISION_BYTES) throw new Error('image is over 4.5 MB, shrink it to index');
          const data = (await fs.readFile(path.join(this.dir, item.file))).toString('base64');
          const j = await chatJson(ai, {
            system: 'You catalogue UI design reference images for a game/app UI designer.',
            prompt:
              'Describe this UI image so it can be found later by search. Return JSON: ' +
              '{"description": "2-3 sentences: what screen/element it is, layout, style, colours, mood", ' +
              '"tags": ["8-15 short lowercase tags: element types (button, shop, inventory, hud, popup, icon, frame...), style (cartoon, flat, glossy, stud, pixel, sci-fi...), colours, platform (roblox, mobile...)"]}' +
              `\nThe file is named "${item.file}", which may hint at its content.`,
            images: [{ mediaType: mediaTypeFor(item.file), data }],
            maxTokens: 600,
          });
          index[item.file] = {
            sig: item.sig,
            description: String(j.description || ''),
            tags: Array.isArray(j.tags) ? j.tags.map(String) : [],
          };
          await this.saveIndex(index);
        } catch (e) {
          errors.push(`${item.file}: ${e.message}`);
        }
        done++;
        onProgress?.(done, todo.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
    await this.saveIndex(index);
    return { indexed: done - errors.length, total: todo.length, errors };
  }

  /**
   * Rank indexed examples against the analysed query.
   * analysis = { description, tags, queries }
   */
  async search(ai, analysis, { limit = 24 } = {}) {
    const items = (await this.list()).filter((i) => i.indexed);
    if (!items.length) return [];

    // Cheap keyword pre-filter so huge folders still fit in one prompt.
    const words = new Set(
      [analysis.description, ...(analysis.tags || []), ...(analysis.queries || [])]
        .join(' ')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 2)
    );
    const scored = items
      .map((it) => {
        const hay = `${it.file} ${it.description} ${it.tags.join(' ')}`.toLowerCase();
        let s = 0;
        for (const w of words) if (hay.includes(w)) s++;
        return { it, s };
      })
      .sort((a, b) => b.s - a.s)
      .slice(0, 150)
      .map((x) => x.it);

    const catalogue = scored
      .map((it, n) => `${n}. [${it.file}] ${it.description} | tags: ${it.tags.join(', ')}`)
      .join('\n');

    const j = await chatJson(ai, {
      system: 'You match UI design references. Be strict: only return genuinely relevant items.',
      prompt:
        `The user is looking for: ${analysis.description}\nTags: ${(analysis.tags || []).join(', ')}\n\n` +
        `Here is their library of UI examples:\n${catalogue}\n\n` +
        `Return JSON {"matches":[{"n": <number>, "score": <0-100>, "reason": "<short why>"}]} with at most ${limit} items, best first. Skip anything below 35.`,
      maxTokens: 2500,
    });
    return (j.matches || [])
      .map((m) => {
        const it = scored[Number(m.n)];
        return it ? { ...it, score: Number(m.score) || 0, reason: m.reason || '' } : null;
      })
      .filter(Boolean);
  }

  safePath(rel) {
    const full = path.resolve(this.dir, rel);
    if (!full.startsWith(path.resolve(this.dir) + path.sep)) throw new Error('Bad path');
    return full;
  }

  async saveBuffer(name, buf, folder = '') {
    const clean = (s) => s.replace(/[^a-zA-Z0-9._ -]/g, '_').replace(/^\.+/, '').slice(0, 100);
    const sub = folder ? folder.split('/').map(clean).filter(Boolean).join('/') : '';
    let base = clean(name) || 'example.png';
    if (!mediaTypeFor(base)) base += '.png';
    const dir = sub ? this.safePath(sub) : this.dir;
    await fs.mkdir(dir, { recursive: true });
    let target = path.join(dir, base);
    const ext = path.extname(base);
    let n = 1;
    while (await fs.stat(target).then(() => true, () => false)) {
      target = path.join(dir, `${path.basename(base, ext)}-${n++}${ext}`);
    }
    await fs.writeFile(target, buf);
    return path.relative(this.dir, target).split(path.sep).join('/');
  }
}
