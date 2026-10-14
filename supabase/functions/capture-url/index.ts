// ============================================================================
// CAPTURE-URL
// ============================================================================
// Your app sends a link here. This function fetches the page ON THE SERVER,
// where the browser's CORS rule does not apply, pulls out the readable text,
// and saves it to your brain.
//
// For now it saves the text without summarising it. Summaries need an AI key,
// which arrives in Level 5 — the enrichment agent there will handle it.
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''

const MAX_BYTES = 3_000_000 // don't try to swallow a giant page
const PREVIEW_CHARS = 4000 // how much text goes in the thoughts row

// Turns things like &amp; and &#39; back into normal characters.
function decodeEntities(s: string): string {
  const safe = (n: number) => {
    try {
      return String.fromCodePoint(n)
    } catch {
      return ''
    }
  }
  return s
    .replace(/&#(\d+);/g, (_, n) => safe(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safe(parseInt(h, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

// Strips a web page down to its title and readable text. Deliberately simple:
// remove the machinery (scripts, menus, footers), then remove the tags.
function htmlToText(html: string): { title: string; text: string } {
  const titleMatch =
    html.match(/<meta\s+property="og:title"\s+content="([^"]*)"/i) ??
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleMatch ? decodeEntities(titleMatch[1]).trim() : 'Untitled page'

  // If the page marks up its main article, use just that part.
  const articleMatch =
    html.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ??
    html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
  const body = articleMatch ? articleMatch[1] : html

  const text = body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<form[\s\S]*?<\/form>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')

  const cleaned = decodeEntities(text)
    .replace(/[ \t\u00a0]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n')
    .trim()

  return { title, text: cleaned }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    // Who is asking? Read from their login token — never from the request body,
    // or anyone could write into anyone else's brain.
    const authHeader = req.headers.get('Authorization') ?? ''
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    })
    const {
      data: { user },
      error: authError,
    } = await userClient.auth.getUser()
    if (authError || !user) return json({ ok: false, error: 'Not signed in' }, 401)

    const { url } = await req.json()
    if (!url || typeof url !== 'string') return json({ ok: false, error: 'A url is required' }, 400)

    // Only normal web links. Blocks tricks that point the server at internal addresses.
    let parsed: URL
    try {
      parsed = new URL(url.trim())
    } catch {
      return json({ ok: false, error: 'That is not a valid web address' }, 400)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return json({ ok: false, error: 'Only http and https links are supported' }, 400)
    }

    // Fetch the page, identifying as a normal browser — some sites refuse obvious bots.
    const pageRes = await fetch(parsed.toString(), {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    })

    if (!pageRes.ok) {
      return json(
        {
          ok: false,
          error: `That page returned an error (HTTP ${pageRes.status}). It may require a login or block automated readers.`,
        },
        422,
      )
    }

    const contentType = pageRes.headers.get('content-type') ?? ''
    if (!contentType.includes('html') && !contentType.includes('text')) {
      return json(
        {
          ok: false,
          error: `That link is a ${contentType.split(';')[0] || 'file'}, not a web page. For PDFs, use the PDF tab.`,
        },
        415,
      )
    }

    const raw = await pageRes.text()
    if (raw.length > MAX_BYTES) return json({ ok: false, error: 'That page is too large to process' }, 413)

    const { title, text } = htmlToText(raw)

    if (text.length < 200) {
      return json(
        {
          ok: false,
          error:
            'Almost no readable text was found. The page probably builds itself with JavaScript ' +
            'after loading, which a server cannot see. Try copying the text in by hand instead.',
        },
        422,
      )
    }

    const preview = text.length > PREVIEW_CHARS ? text.slice(0, PREVIEW_CHARS) + '…' : text
    const content = `🔗 ${title}\n${parsed.hostname}\n\n${preview}`

    // Write with the admin (service role) client, always stamping the real owner.
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })

    const { data: thought, error: insertError } = await admin
      .from('thoughts')
      .insert({
        user_id: user.id,
        content,
        metadata: { source: 'url', title, url: parsed.toString(), hostname: parsed.hostname },
      })
      .select('id')
      .single()

    if (insertError) throw insertError

    // Keep the complete text too. Non-fatal: the thought is already saved either way.
    const { error: sourceError } = await admin.from('thought_sources').insert({
      thought_id: thought.id,
      user_id: user.id,
      source_text: text,
      source_kind: 'web',
      char_count: text.length,
      truncated: false,
    })
    if (sourceError) console.error('[url] thought_sources insert failed (non-fatal):', sourceError)

    return json({
      ok: true,
      title,
      hostname: parsed.hostname,
      chars: text.length,
      preview: content.slice(0, 240) + '…',
    })
  } catch (err) {
    console.error('[url] Failed:', err)
    const msg = String(err).toLowerCase().includes('timeout')
      ? 'That page took too long to respond.'
      : err instanceof Error
        ? err.message
        : JSON.stringify(err)
    return json({ ok: false, error: msg }, 500)
  }
})