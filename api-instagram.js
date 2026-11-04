/**
 * api/instagram.js — Vercel serverless route
 * ---------------------------------------------------------------
 * Keeps the Instagram access token server-side. The browser never
 * sees it. Response is cached at the edge for one hour, so three
 * channels on a busy page cost roughly 72 Meta calls per day, not
 * one per visitor.
 *
 * SETUP
 * 1. Each account must be an Instagram Business or Creator account
 *    linked to a Facebook Page. Personal accounts cannot do this —
 *    Basic Display was shut down 4 Dec 2024.
 * 2. Create a Meta app → add "Instagram Graph API" → request the
 *    instagram_basic and pages_read_engagement permissions.
 * 3. The ACCOUNT OWNER completes OAuth. You cannot self-authorise
 *    a client's account.
 * 4. Exchange for a long-lived token (60 days) and store it as a
 *    Vercel environment variable, one per account:
 *
 *      IG_TOKEN_SASHABEAUTYSALON=...
 *      IG_TOKEN_SASHA_AESTHETICS_CLINIC=...
 *      IG_TOKEN_DENZAROSSA=...
 *      IG_USER_SASHABEAUTYSALON=17841400000000000   (IG user id)
 *      ...
 *
 * 5. Long-lived tokens expire. Add a weekly Vercel cron that calls
 *    the refresh endpoint, or the feeds go dark on day 61.
 *
 * FRONTEND
 *   source: { type:'proxy', url:'/api/instagram?account=sashabeautysalon' }
 * ---------------------------------------------------------------
 */

const FIELDS = 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp';

const ALLOWED = new Set([
  'sashabeautysalon',
  'sasha_aesthetics_clinic',
  'denzarossa'
]);

function envKey(account, prefix) {
  return `${prefix}_${account.toUpperCase()}`;
}

export default async function handler(req, res) {
  const account = String(req.query.account || '').toLowerCase();
  const limit = Math.min(parseInt(req.query.limit, 10) || 6, 12);

  if (!ALLOWED.has(account)) {
    return res.status(400).json({ error: 'Unknown account' });
  }

  const token = process.env[envKey(account, 'IG_TOKEN')];
  const userId = process.env[envKey(account, 'IG_USER')];

  if (!token || !userId) {
    return res.status(503).json({
      error: 'Not connected',
      detail: `Missing ${envKey(account, 'IG_TOKEN')} or ${envKey(account, 'IG_USER')}`
    });
  }

  const url =
    `https://graph.instagram.com/v21.0/${userId}/media` +
    `?fields=${FIELDS}&limit=${limit}&access_token=${token}`;

  try {
    const r = await fetch(url);
    const json = await r.json();

    if (!r.ok || json.error) {
      // Do not leak the token or Meta's internal trace back to the client
      console.error('[instagram]', account, json.error || r.status);
      return res.status(502).json({ error: 'Upstream rejected the request' });
    }

    const data = (json.data || []).map((p) => ({
      id: p.id,
      permalink: p.permalink,
      media_type: p.media_type,
      // Videos expose a still in thumbnail_url; images do not have one
      media_url: p.media_url,
      thumbnail_url: p.thumbnail_url || p.media_url,
      caption: (p.caption || '').slice(0, 160),
      timestamp: p.timestamp
    }));

    // Edge cache 1h, serve stale for 24h while revalidating
    res.setHeader(
      'Cache-Control',
      'public, s-maxage=3600, stale-while-revalidate=86400'
    );
    return res.status(200).json({ account, count: data.length, data });
  } catch (err) {
    console.error('[instagram]', account, err);
    return res.status(502).json({ error: 'Fetch failed' });
  }
}
