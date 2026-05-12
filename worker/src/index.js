// Printoken AI proxy — Cloudflare Worker
//
// Receives { prompt, style, name, types, subtypes, colors, description }
// from the browser, proxies to fal.ai Flux Schnell, logs inputs to D1,
// and returns { imageUrl }.
//
// Protection: CORS origin allowlist + fal.ai spend cap.
//
// Secrets (set via `wrangler secret put`, never commit):
//   FAL_KEY — your fal.ai API key

const ALLOWED_ORIGINS = [
  'https://thepatchedfool.github.io',
  'http://localhost:8080',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://localhost:3000',
];

const FAL_ENDPOINT = 'https://fal.run/fal-ai/flux/schnell';

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : null;

    // ── CORS preflight ──────────────────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return corsOrigin
        ? new Response(null, { status: 204, headers: corsHeaders(corsOrigin) })
        : new Response('Forbidden', { status: 403 });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    // ── Parse body ──────────────────────────────────────────────────────────
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonError('Invalid JSON', 400, corsOrigin);
    }

    const {
      prompt,
      style       = '',
      name        = '',
      types       = '',
      subtypes    = '',
      colors      = '',
      description = '',
    } = body;

    // ── Validate ────────────────────────────────────────────────────────────
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return jsonError('prompt is required', 400, corsOrigin);
    }
    if (prompt.length > 600) {
      return jsonError('prompt too long (max 600 chars)', 400, corsOrigin);
    }

    // ── Call fal.ai ─────────────────────────────────────────────────────────
    let falResp;
    try {
      falResp = await fetch(FAL_ENDPOINT, {
        method: 'POST',
        headers: {
          'Authorization': `Key ${env.FAL_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt: prompt.trim(),
          image_size: 'square_hd',
          num_inference_steps: 4,
          num_images: 1,
          enable_safety_checker: true,
        }),
      });
    } catch (err) {
      console.error('fal.ai fetch error', err);
      return jsonError('Image generation failed', 502, corsOrigin);
    }

    if (!falResp.ok) {
      const text = await falResp.text().catch(() => '');
      console.error('fal.ai error', falResp.status, text);
      return jsonError('Image generation failed', 502, corsOrigin);
    }

    const falJson = await falResp.json();
    const imageUrl = falJson.images?.[0]?.url;
    if (!imageUrl) {
      return jsonError('No image returned by fal.ai', 502, corsOrigin);
    }

    // ── Log to D1 (non-blocking — never delays the response) ────────────────
    ctx.waitUntil(
      env.DB.prepare(
        `INSERT INTO prompts (ts, style, name, types, subtypes, colors, description, prompt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(Date.now(), style, name, types, subtypes, colors, description, prompt.trim())
      .run()
      .catch(err => console.error('D1 insert failed:', err))
    );

    return new Response(JSON.stringify({ imageUrl }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(corsOrigin) },
    });
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function corsHeaders(origin) {
  if (!origin) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonError(message, status, corsOrigin) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(corsOrigin) },
  });
}
