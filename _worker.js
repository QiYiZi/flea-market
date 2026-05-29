// Cloudflare Worker for flea market comment API
// API routes: /api/comments/:itemId
// Everything else falls through to static assets

const ADMIN_PASSWORD = '123456';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (url.pathname.startsWith('/api/comments/')) {
      return handleComments(request, env, url);
    }

    return env.ASSETS.fetch(request);
  }
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders() });
}

async function handleComments(request, env, url) {
  const itemId = url.pathname.split('/')[3];

  if (!itemId || !/^\d+$/.test(itemId)) {
    return json({ error: '无效的物品ID' }, 400);
  }

  const key = `comments:${itemId}`;

  try {
    switch (request.method) {
      case 'GET': {
        const data = await env.COMMENTS_KV.get(key);
        const comments = data ? JSON.parse(data) : [];
        return json({ comments, count: comments.length });
      }

      case 'POST': {
        const ip = request.headers.get('cf-connecting-ip') || 'unknown';
        const ipHash = await hashIP(ip);
        const rateKey = `ratelimit:${ipHash}`;
        const limited = await env.COMMENTS_KV.get(rateKey);
        if (limited) {
          return json({ error: '发送太频繁，请稍后再试' }, 429);
        }
        await env.COMMENTS_KV.put(rateKey, '1', { expirationTtl: 5 });

        let body;
        try { body = await request.json(); } catch { return json({ error: '请求格式错误' }, 400); }

        const nickname = sanitize(body.nickname || '').slice(0, 20);
        const message = sanitize(body.message || '').slice(0, 500);
        if (!nickname || !message) {
          return json({ error: '昵称和留言不能为空' }, 400);
        }

        const comment = {
          id: `c_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          nickname,
          message,
          createdAt: Date.now()
        };

        const existingData = await env.COMMENTS_KV.get(key);
        const comments = existingData ? JSON.parse(existingData) : [];
        comments.push(comment);
        await env.COMMENTS_KV.put(key, JSON.stringify(comments));

        return json({ success: true, comment });
      }

      case 'DELETE': {
        let body;
        try { body = await request.json(); } catch { return json({ error: '请求格式错误' }, 400); }
        const { password, commentId } = body;

        if (!password || password !== ADMIN_PASSWORD) {
          return json({ error: '密码错误' }, 403);
        }
        if (!commentId) {
          return json({ error: '缺少commentId' }, 400);
        }

        const existingData = await env.COMMENTS_KV.get(key);
        if (!existingData) {
          return json({ error: '没有留言' }, 404);
        }
        const comments = JSON.parse(existingData);
        const idx = comments.findIndex(c => c.id === commentId);
        if (idx === -1) {
          return json({ error: '留言不存在' }, 404);
        }
        comments.splice(idx, 1);

        if (comments.length === 0) {
          await env.COMMENTS_KV.delete(key);
        } else {
          await env.COMMENTS_KV.put(key, JSON.stringify(comments));
        }

        return json({ success: true });
      }

      default:
        return json({ error: '方法不允许' }, 405);
    }
  } catch (e) {
    console.error(e);
    return json({ error: '服务器错误' }, 500);
  }
}

function sanitize(str) {
  return String(str)
    .replace(/<[^>]*>/g, '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .trim();
}

async function hashIP(ip) {
  const encoder = new TextEncoder();
  const data = encoder.encode(ip + 'flea-market-salt');
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}
