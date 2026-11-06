// Thin wrappers around the AI providers. Every call takes the user's own
// key + model from the UI; nothing is stored on the server.

const OPENAI_COMPAT = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  groq: 'https://api.groq.com/openai/v1',
};

export const PROVIDERS = {
  anthropic: { label: 'Anthropic (Claude)', models: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'] },
  openai: { label: 'OpenAI', models: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini'] },
  gemini: { label: 'Google Gemini', models: ['gemini-2.5-flash', 'gemini-2.5-pro'] },
  openrouter: { label: 'OpenRouter', models: ['anthropic/claude-sonnet-5-5', 'openai/gpt-4.1', 'google/gemini-2.5-flash'] },
  groq: { label: 'Groq', models: ['meta-llama/llama-4-scout-17b-16e-instruct'] },
  custom: { label: 'Custom (OpenAI-compatible)', models: [] },
};

function requireAi(ai) {
  if (!ai || !ai.provider) throw new Error('Pick an AI provider in Settings.');
  if (!ai.key && ai.provider !== 'custom') throw new Error('Add your AI API key in Settings.');
  if (!ai.model) throw new Error('Pick a model in Settings.');
}

function baseUrlFor(ai) {
  if (ai.provider === 'custom') {
    if (!ai.baseUrl) throw new Error('Custom provider needs a base URL (e.g. http://localhost:11434/v1).');
    return ai.baseUrl.replace(/\/+$/, '');
  }
  return OPENAI_COMPAT[ai.provider];
}

async function readError(res) {
  const t = await res.text();
  try {
    const j = JSON.parse(t);
    return j.error?.message || j.error || j.message || t;
  } catch {
    return t.slice(0, 400);
  }
}

/**
 * images: [{ mediaType: 'image/png', data: '<base64>' }]
 * returns the model's text reply.
 */
export async function chat(ai, { system, prompt, images = [], maxTokens = 2000 }) {
  requireAi(ai);

  if (ai.provider === 'anthropic') {
    const content = [
      ...images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.data } })),
      { type: 'text', text: prompt },
    ];
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ai.key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: ai.model, max_tokens: maxTokens, system, messages: [{ role: 'user', content }] }),
    });
    if (!res.ok) throw new Error(`Anthropic: ${await readError(res)}`);
    const j = await res.json();
    return j.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  }

  if (ai.provider === 'gemini') {
    const parts = [
      ...images.map((im) => ({ inline_data: { mime_type: im.mediaType, data: im.data } })),
      { text: prompt },
    ];
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(ai.model)}:generateContent`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': ai.key },
      body: JSON.stringify({
        systemInstruction: system ? { parts: [{ text: system }] } : undefined,
        contents: [{ role: 'user', parts }],
        generationConfig: { maxOutputTokens: maxTokens },
      }),
    });
    if (!res.ok) throw new Error(`Gemini: ${await readError(res)}`);
    const j = await res.json();
    return (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('\n');
  }

  // OpenAI-compatible (openai, openrouter, groq, custom/ollama/lmstudio)
  const content = [
    { type: 'text', text: prompt },
    ...images.map((im) => ({ type: 'image_url', image_url: { url: `data:${im.mediaType};base64,${im.data}` } })),
  ];
  const headers = { 'content-type': 'application/json' };
  if (ai.key) headers.authorization = `Bearer ${ai.key}`;
  const res = await fetch(`${baseUrlFor(ai)}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: ai.model,
      max_tokens: maxTokens,
      messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content }],
    }),
  });
  if (!res.ok) throw new Error(`${ai.provider}: ${await readError(res)}`);
  const j = await res.json();
  const msg = j.choices?.[0]?.message?.content;
  return Array.isArray(msg) ? msg.map((m) => m.text || '').join('\n') : msg || '';
}

/** Ask for JSON and parse it robustly. */
export async function chatJson(ai, opts) {
  const text = await chat(ai, {
    ...opts,
    system: `${opts.system || ''}\nReply with ONLY valid JSON. No markdown fences, no commentary.`.trim(),
  });
  return parseJson(text);
}

export function parseJson(text) {
  const cleaned = String(text).replace(/```(?:json)?/gi, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.search(/[[{]/);
    const open = cleaned[start];
    const close = open === '[' ? ']' : '}';
    const end = cleaned.lastIndexOf(close);
    if (start === -1 || end === -1) throw new Error('The model did not return JSON. Try a stronger model.');
    return JSON.parse(cleaned.slice(start, end + 1));
  }
}

/** List models from the provider so the user can choose. */
export async function listModels(ai) {
  if (!ai?.provider) throw new Error('Pick a provider first.');
  if (ai.provider === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
      headers: { 'x-api-key': ai.key, 'anthropic-version': '2023-06-01' },
    });
    if (!res.ok) throw new Error(`Anthropic: ${await readError(res)}`);
    return (await res.json()).data.map((m) => m.id);
  }
  if (ai.provider === 'gemini') {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', {
      headers: { 'x-goog-api-key': ai.key },
    });
    if (!res.ok) throw new Error(`Gemini: ${await readError(res)}`);
    return (await res.json()).models
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, ''));
  }
  const headers = {};
  if (ai.key) headers.authorization = `Bearer ${ai.key}`;
  const res = await fetch(`${baseUrlFor(ai)}/models`, { headers });
  if (!res.ok) throw new Error(`${ai.provider}: ${await readError(res)}`);
  return (await res.json()).data.map((m) => m.id).sort();
}
