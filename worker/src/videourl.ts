// Turns whatever URL the admin pasted into one that actually renders in an
// iframe, and refuses anything that isn't a known video embed.
//
// This exists because the two links Glenn will paste most often — a YouTube
// "watch" URL and a Google Drive "share" URL — both render a blank iframe as-is.
// Normalizing in the browser would be pointless: the value ends up in an
// `iframe src`, so the check has to be server-side where it can't be skipped.
//
// Pure module, no KV or env — unit-tested directly.

export type Provider =
  | 'youtube'
  | 'drive'
  | 'vimeo'
  | 'facebook'
  | 'instagram'
  | 'tiktok'
  | 'loom';

export interface NormalizedEmbed {
  embedUrl: string;
  provider: Provider;
  // The page a viewer should be sent to when they click through — always the
  // original public post, so views and engagement land on it rather than here.
  sourceUrl: string;
}

export type EmbedResult =
  | { ok: true; value: NormalizedEmbed }
  | { ok: false; error: string };

const YT_ID = /^[A-Za-z0-9_-]{6,20}$/;
const DRIVE_ID = /^[A-Za-z0-9_-]{10,100}$/;
const DIGITS = /^\d{5,20}$/;
const SLUG = /^[A-Za-z0-9_-]{3,60}$/;

function fail(error: string): EmbedResult {
  return { ok: false, error };
}

// Already-normalized embed URLs are allowed straight through, but only from
// hosts on this list. Without it, "it's already an embed link" would be a hole
// wide enough to put any origin in an iframe on the library page.
const EMBED_HOSTS = new Set([
  'www.youtube.com',
  'youtube.com',
  'www.youtube-nocookie.com',
  'youtube-nocookie.com',
  'drive.google.com',
  'player.vimeo.com',
  'www.facebook.com',
  'www.instagram.com',
  'instagram.com',
  'www.tiktok.com',
  'www.loom.com',
]);

function stripWww(host: string): string {
  return host.replace(/^www\./, '').toLowerCase();
}

export function normalizeEmbedUrl(raw: string): EmbedResult {
  const input = (raw || '').trim();
  if (!input) return fail('Enter a video URL.');
  if (input.length > 2000) return fail('That URL is too long.');

  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return fail('That does not look like a valid URL. Include https://');
  }

  // Reject every non-https scheme explicitly rather than allowlisting https
  // implicitly — javascript: and data: are the ones that matter here, and an
  // http: embed would be blocked as mixed content anyway.
  if (u.protocol !== 'https:') return fail('Use an https:// link.');

  const host = stripWww(u.hostname);
  const path = u.pathname.replace(/\/+$/, '');

  // ---- YouTube -----------------------------------------------------------
  if (host === 'youtu.be') {
    const id = path.slice(1);
    if (!YT_ID.test(id)) return fail('Could not find a YouTube video id in that link.');
    return youtube(id);
  }
  if (host === 'youtube.com' || host === 'youtube-nocookie.com' || host === 'm.youtube.com') {
    if (path === '/watch') {
      const id = u.searchParams.get('v') || '';
      if (!YT_ID.test(id)) return fail('Could not find a YouTube video id in that link.');
      return youtube(id);
    }
    const m = path.match(/^\/(?:embed|shorts|live|v)\/([^/?#]+)/);
    if (m && YT_ID.test(m[1])) return youtube(m[1]);
    return fail('That YouTube link has no video id. Use the link from Share, or the address bar on a video page.');
  }

  // ---- Google Drive ------------------------------------------------------
  if (host === 'drive.google.com') {
    const m = path.match(/^\/file\/d\/([^/]+)/);
    const id = m?.[1] || u.searchParams.get('id') || '';
    if (!DRIVE_ID.test(id)) return fail('Could not find a Google Drive file id in that link.');
    return {
      ok: true,
      value: {
        // /preview is the embeddable view; /view renders blank in an iframe.
        embedUrl: `https://drive.google.com/file/d/${id}/preview`,
        provider: 'drive',
        sourceUrl: `https://drive.google.com/file/d/${id}/view`,
      },
    };
  }
  if (host === 'docs.google.com') {
    return fail('That is a Docs link. Open the video in Google Drive and copy its share link instead.');
  }

  // ---- Vimeo -------------------------------------------------------------
  if (host === 'vimeo.com') {
    const id = path.slice(1).split('/')[0];
    if (!DIGITS.test(id)) return fail('Could not find a Vimeo video id in that link.');
    return {
      ok: true,
      value: {
        embedUrl: `https://player.vimeo.com/video/${id}`,
        provider: 'vimeo',
        sourceUrl: `https://vimeo.com/${id}`,
      },
    };
  }
  if (host === 'player.vimeo.com') {
    const m = path.match(/^\/video\/(\d+)/);
    if (!m) return fail('Could not find a Vimeo video id in that link.');
    return {
      ok: true,
      value: {
        embedUrl: `https://player.vimeo.com/video/${m[1]}`,
        provider: 'vimeo',
        sourceUrl: `https://vimeo.com/${m[1]}`,
      },
    };
  }

  // ---- Loom --------------------------------------------------------------
  if (host === 'loom.com') {
    const m = path.match(/^\/(?:share|embed)\/([^/?#]+)/);
    if (!m || !DRIVE_ID.test(m[1])) return fail('Could not find a Loom video id in that link.');
    return {
      ok: true,
      value: {
        embedUrl: `https://www.loom.com/embed/${m[1]}`,
        provider: 'loom',
        sourceUrl: `https://www.loom.com/share/${m[1]}`,
      },
    };
  }

  // ---- Instagram ---------------------------------------------------------
  if (host === 'instagram.com') {
    const m = path.match(/^\/(p|reel|reels|tv)\/([^/?#]+)/);
    if (!m || !SLUG.test(m[2])) return fail('Could not find an Instagram post id in that link.');
    const kind = m[1] === 'reels' ? 'reel' : m[1];
    return {
      ok: true,
      value: {
        embedUrl: `https://www.instagram.com/${kind}/${m[2]}/embed/`,
        provider: 'instagram',
        sourceUrl: `https://www.instagram.com/${kind}/${m[2]}/`,
      },
    };
  }

  // ---- TikTok ------------------------------------------------------------
  if (host === 'tiktok.com') {
    const m = path.match(/\/video\/(\d+)/);
    if (!m) return fail('Use a full TikTok video link (the one containing /video/).');
    return {
      ok: true,
      value: {
        embedUrl: `https://www.tiktok.com/embed/v2/${m[1]}`,
        provider: 'tiktok',
        sourceUrl: input,
      },
    };
  }

  // ---- Facebook ----------------------------------------------------------
  if (host === 'facebook.com' || host === 'fb.watch') {
    if (path === '/plugins/video.php') {
      const href = u.searchParams.get('href');
      if (!href) return fail('That Facebook embed link is missing its href.');
      return {
        ok: true,
        value: { embedUrl: u.toString(), provider: 'facebook', sourceUrl: href },
      };
    }
    return {
      ok: true,
      value: {
        embedUrl: `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(input)}&show_text=false`,
        provider: 'facebook',
        sourceUrl: input,
      },
    };
  }

  if (EMBED_HOSTS.has(u.hostname.toLowerCase())) {
    return fail('That link is from a supported site but is not a video URL.');
  }

  return fail(
    'Unsupported video host. Supported: YouTube, Google Drive, Vimeo, Loom, Instagram, TikTok, Facebook.'
  );
}

function youtube(id: string): EmbedResult {
  return {
    ok: true,
    value: {
      // rel=0 keeps the end-screen suggestions within the same channel, which
      // matches the single YouTube embed already on the main site.
      embedUrl: `https://www.youtube.com/embed/${id}?rel=0`,
      provider: 'youtube',
      sourceUrl: `https://www.youtube.com/watch?v=${id}`,
    },
  };
}
