/**
 * research-tools.js — HTTP-based helpers for the Hexis deep-research pipeline.
 *
 * All tools here are FREE (no API keys required):
 *   - Jina Reader   r.jina.ai/{url}        web page → clean markdown
 *   - Jina Search   s.jina.ai/?q={query}   web search → markdown snippets
 *   - arXiv API     export.arxiv.org/api   academic papers
 *   - GitHub API    api.github.com/search  repos, code, issues (60 req/hr anon)
 *   - HN Algolia    hn.algolia.com/api/v1  Hacker News posts + comments
 *
 * These are plain async fetch helpers — they're wrapped as MCP tools in
 * hexis-mcp-tools.js so the research agents can call them.
 *
 * Design notes:
 *   - All functions return `{ ok: true, data }` or `{ ok: false, error }`.
 *     Callers never have to try/catch.
 *   - Every response is capped to avoid blowing up the agent's context.
 *   - Freshness fields (`published`, `updated`) are normalized to ISO dates
 *     so the agent can age-weight sources.
 *   - User-Agent is set so arXiv and GitHub don't rate-limit us.
 */

const UA = 'Hexis-Research/1.0 (+https://github.com/hexis)';
const DEFAULT_TIMEOUT_MS = 25_000;

/** fetch with timeout + UA, returning raw Response. */
async function fetchWithTimeout(url, init = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeout || DEFAULT_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, ...(init.headers || {}) },
    });
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────────────────────
// DuckDuckGo HTML — free web search (no API key, no rate limit for polite use)
// ─────────────────────────────────────────────────────────────

/**
 * DuckDuckGo HTML search — free, no API key. We scrape the non-JS HTML
 * result page (`html.duckduckgo.com/html/?q=...`) because the JSON API is
 * instant-answer only and doesn't return actual web results.
 *
 * This is our PRIMARY web search tool — Jina's s.jina.ai now requires a
 * key and the Agent SDK v0.2.98 doesn't expose WebSearch as a tool, so
 * DuckDuckGo is what researchers use to discover URLs.
 */
export async function ddgSearch(query, { max = 10 } = {}) {
  if (!query?.trim()) return { ok: false, error: 'empty query' };
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetchWithTimeout(url, {
      headers: {
        'Accept': 'text/html',
        'Accept-Language': 'en-US,en;q=0.5',
      },
    });
    if (!res.ok) return { ok: false, error: `ddg ${res.status}` };
    const html = await res.text();

    // Each result is in a .result block. Parse title, url, snippet.
    const results = [];
    // Match <a class="result__a" href="/l/?uddg=<url>&...">title</a>
    const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
    const snippetRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

    const links = [...html.matchAll(linkRe)];
    const snippets = [...html.matchAll(snippetRe)];

    for (let i = 0; i < Math.min(links.length, max); i++) {
      let rawHref = links[i][1];
      // DDG wraps result URLs through /l/?uddg=<encoded-url>&...
      let finalUrl = rawHref;
      const uddgMatch = rawHref.match(/[?&]uddg=([^&]+)/);
      if (uddgMatch) {
        try { finalUrl = decodeURIComponent(uddgMatch[1]); } catch { finalUrl = rawHref; }
      } else if (rawHref.startsWith('//')) {
        finalUrl = 'https:' + rawHref;
      }
      const title = stripHtml(links[i][2]);
      const snippet = snippets[i] ? stripHtml(snippets[i][1]) : '';
      if (finalUrl?.startsWith('http')) {
        results.push({
          title,
          url: finalUrl,
          snippet: snippet.slice(0, 400),
        });
      }
    }

    return { ok: true, data: { query, count: results.length, results } };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

function stripHtml(s) {
  return (s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─────────────────────────────────────────────────────────────
// JINA Reader — free URL → clean markdown (no API key)
// ─────────────────────────────────────────────────────────────

/**
 * Jina Reader — turn any URL into clean LLM-friendly markdown.
 * Endpoint: https://r.jina.ai/<url>
 * Strips ads, nav, footer; returns the main content as markdown.
 * This is the SINGLE best free way to turn a web page into something
 * an LLM can actually digest — far better than raw HTML fetch.
 */
export async function jinaFetch(url, { maxChars = 20_000 } = {}) {
  if (!url?.startsWith('http')) return { ok: false, error: 'url must be http(s)' };
  try {
    const readerUrl = `https://r.jina.ai/${url}`;
    const res = await fetchWithTimeout(readerUrl, {
      headers: {
        'Accept': 'text/plain',
        // Return just the body text — no images, no links metadata bloat
        'X-Return-Format': 'markdown',
      },
    });
    if (!res.ok) return { ok: false, error: `jina reader ${res.status}` };
    const text = await res.text();
    return {
      ok: true,
      data: {
        url,
        content: text.slice(0, maxChars),
        truncated: text.length > maxChars,
        chars: text.length,
      },
    };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

// ─────────────────────────────────────────────────────────────
// arXiv API — free academic paper search
// ─────────────────────────────────────────────────────────────

function stripXmlTags(s) {
  return (s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}
function extractXmlField(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? stripXmlTags(m[1]) : '';
}
function extractXmlAttr(xml, tag, attr) {
  const m = xml.match(new RegExp(`<${tag}[^>]*\\s${attr}="([^"]*)"`));
  return m ? m[1] : '';
}

/**
 * arXiv Search — free academic paper search (no API key, no rate limit for polite use).
 * Endpoint: http://export.arxiv.org/api/query
 */
export async function arxivSearch(query, { max = 5 } = {}) {
  if (!query?.trim()) return { ok: false, error: 'empty query' };
  try {
    const url =
      `http://export.arxiv.org/api/query` +
      `?search_query=${encodeURIComponent('all:' + query)}` +
      `&start=0&max_results=${max}` +
      `&sortBy=relevance&sortOrder=descending`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return { ok: false, error: `arxiv ${res.status}` };
    const xml = await res.text();

    // Quick parse — we only need entry blocks
    const entryMatches = xml.match(/<entry>[\s\S]*?<\/entry>/g) || [];
    const papers = entryMatches.slice(0, max).map(entry => ({
      id: extractXmlField(entry, 'id'),
      title: extractXmlField(entry, 'title'),
      summary: extractXmlField(entry, 'summary').slice(0, 1200),
      published: extractXmlField(entry, 'published'),
      updated: extractXmlField(entry, 'updated'),
      authors: (entry.match(/<author>[\s\S]*?<\/author>/g) || [])
        .map(a => extractXmlField(a, 'name'))
        .slice(0, 6),
      pdfUrl: extractXmlAttr(entry, 'link title="pdf"', 'href') || null,
    }));
    return { ok: true, data: { query, count: papers.length, papers } };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

// ─────────────────────────────────────────────────────────────
// GitHub Search — repos, code, issues (60 req/hr unauthenticated)
// ─────────────────────────────────────────────────────────────

/**
 * GitHub search — repos / code / issues. Uses public API unauthenticated
 * (60 req/hr). If GITHUB_TOKEN is set in env, uses it for 5000 req/hr.
 *
 * @param {string} query - search string (can include GitHub qualifiers like "stars:>1000 language:typescript")
 * @param {'repositories'|'code'|'issues'} type
 */
export async function githubSearch(query, { type = 'repositories', max = 10 } = {}) {
  if (!query?.trim()) return { ok: false, error: 'empty query' };
  try {
    const url = `https://api.github.com/search/${type}?q=${encodeURIComponent(query)}&per_page=${max}&sort=stars&order=desc`;
    const headers = { 'Accept': 'application/vnd.github+json' };
    if (process.env.GITHUB_TOKEN) {
      headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
    }
    const res = await fetchWithTimeout(url, { headers });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: `github ${res.status} ${body.slice(0, 200)}` };
    }
    const json = await res.json();
    const items = (json.items || []).slice(0, max).map(item => {
      if (type === 'repositories') {
        return {
          fullName: item.full_name,
          url: item.html_url,
          description: item.description || '',
          stars: item.stargazers_count,
          forks: item.forks_count,
          language: item.language,
          updated: item.updated_at,
          pushed: item.pushed_at,
          license: item.license?.spdx_id || null,
          topics: (item.topics || []).slice(0, 6),
        };
      }
      if (type === 'issues') {
        return {
          title: item.title,
          url: item.html_url,
          state: item.state,
          comments: item.comments,
          created: item.created_at,
          repository: item.repository_url?.replace('https://api.github.com/repos/', '') || '',
          body: (item.body || '').slice(0, 500),
        };
      }
      // code
      return {
        path: item.path,
        url: item.html_url,
        repository: item.repository?.full_name || '',
      };
    });
    return { ok: true, data: { query, type, total: json.total_count, count: items.length, items } };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

// ─────────────────────────────────────────────────────────────
// HN Algolia Search — free, unlimited
// ─────────────────────────────────────────────────────────────

/**
 * Hacker News search via the official Algolia-powered API.
 * Free, no rate limit. Excellent for finding community sentiment on libraries/tools.
 */
export async function hnSearch(query, { max = 10, tag = 'story' } = {}) {
  if (!query?.trim()) return { ok: false, error: 'empty query' };
  try {
    const url =
      `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}` +
      `&tags=${tag}&hitsPerPage=${max}`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return { ok: false, error: `hn ${res.status}` };
    const json = await res.json();
    const hits = (json.hits || []).slice(0, max).map(h => ({
      title: h.title || h.story_title || '',
      url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      hnUrl: `https://news.ycombinator.com/item?id=${h.objectID}`,
      points: h.points || 0,
      numComments: h.num_comments || 0,
      created: h.created_at,
      author: h.author || '',
    }));
    return { ok: true, data: { query, count: hits.length, hits } };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

// ─────────────────────────────────────────────────────────────
// NPM registry — metadata for any published package
// ─────────────────────────────────────────────────────────────

/**
 * NPM package lookup — metadata for a specific package (license, latest version,
 * dependencies, maintainers, repository URL, last publish date).
 * Useful for vetting library maturity / abandonment.
 */
export async function npmInfo(pkg) {
  if (!pkg?.trim()) return { ok: false, error: 'empty package name' };
  try {
    const url = `https://registry.npmjs.org/${encodeURIComponent(pkg)}`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return { ok: false, error: `npm ${res.status}` };
    const json = await res.json();
    const latest = json['dist-tags']?.latest || '';
    const latestInfo = latest ? (json.versions?.[latest] || {}) : {};
    const weeklyDownloads = await fetchWithTimeout(
      `https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(pkg)}`
    ).then(r => r.ok ? r.json() : null).catch(() => null);
    return {
      ok: true,
      data: {
        name: json.name,
        description: json.description || '',
        latestVersion: latest,
        license: latestInfo.license || json.license || null,
        repository: latestInfo.repository?.url || json.repository?.url || null,
        homepage: latestInfo.homepage || json.homepage || null,
        maintainers: (json.maintainers || []).map(m => m.name).slice(0, 5),
        lastPublish: json.time?.[latest] || null,
        created: json.time?.created || null,
        modified: json.time?.modified || null,
        weeklyDownloads: weeklyDownloads?.downloads || null,
        depCount: Object.keys(latestInfo.dependencies || {}).length,
      },
    };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}
