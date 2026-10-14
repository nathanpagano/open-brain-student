// telegram-bot — receives messages from Telegram (via webhook),
// saves them as thoughts, or searches your brain and replies.

import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// Secrets, read from Supabase's secret manager — never written in code.
const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
const OWNER_USER_ID = Deno.env.get('OWNER_USER_ID') ?? ''
const ALLOWED_CHAT_ID = Deno.env.get('TELEGRAM_ALLOWED_CHAT_ID') ?? ''
// These two are provided to every edge function automatically by Supabase.
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

// The service role key bypasses your Level 2 security rule, so EVERY
// query below must filter by OWNER_USER_ID itself.
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

const HELP_TEXT =
  'Your Open Brain bot 🧠\n\n' +
  '• Send any message → saved to your brain\n' +
  '• /search word  (or  ?word) → find matching thoughts\n' +
  '• /recent → your last 5 thoughts'

   async function sendMessage(chatId: number, text: string) {
     if (!TELEGRAM_BOT_TOKEN) {
       console.error('TELEGRAM_BOT_TOKEN secret is empty or missing')
       return
     }
     const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
       method: 'POST',
       headers: { 'Content-Type': 'application/json' },
       // Telegram rejects messages over 4096 characters.
       body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000) }),
     })
     if (!res.ok) {
       console.error('Telegram refused the reply:', res.status, await res.text())
     } else {
       console.log('Reply sent to chat', chatId)
     }
   }

// Stops characters like % and _ from acting as wildcards in a search.
function escapeLike(s: string) {
  return s.replace(/[\\%_]/g, (c) => '\\' + c)
}

function formatThoughts(rows: { content: string | null; created_at: string }[]) {
  return rows
    .map((r, i) => {
      const date = new Date(r.created_at).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
      })
      const body = r.content ?? ''
      const short = body.length > 300 ? body.slice(0, 300) + '…' : body
      return `${i + 1}. (${date}) ${short}`
    })
    .join('\n\n')
}

Deno.serve(async (req) => {
  // Always answer Telegram with 200, or it will keep re-sending the same message.
  const ok = () => new Response('ok', { status: 200, headers: corsHeaders })

  if (req.method === 'OPTIONS') return ok()
  if (req.method !== 'POST') return ok()

  let chatId: number | undefined

  try {
    const update = await req.json()
    const message = update.message ?? update.edited_message
    if (!message) return ok()

    chatId = message.chat.id as number

    // Only text for now — photos, stickers and voice notes are ignored.
    if (!message.text) {
      await sendMessage(chatId, 'For now I can only save text messages.')
      return ok()
    }

    const text = String(message.text).trim()

    // First-time setup: tell the owner their chat ID.
    if (!ALLOWED_CHAT_ID) {
      await sendMessage(
        chatId,
        `Setup step: your chat ID is ${chatId}\n\n` +
          'Add it in Supabase → Edge Functions → Secrets as TELEGRAM_ALLOWED_CHAT_ID, then message me again.',
      )
      return ok()
    }

    // Anyone else who finds the bot is silently ignored.
    if (String(chatId) !== ALLOWED_CHAT_ID.trim()) return ok()

    if (!OWNER_USER_ID) {
      await sendMessage(chatId, 'Setup problem: the OWNER_USER_ID secret is missing.')
      return ok()
    }

    // /start and /help
    if (text === '/start' || text === '/help') {
      await sendMessage(chatId, HELP_TEXT)
      return ok()
    }

    // /recent → last 5 thoughts
    if (text.startsWith('/recent')) {
      const { data, error } = await supabase
        .from('thoughts')
        .select('content, created_at')
        .eq('user_id', OWNER_USER_ID)
        .order('created_at', { ascending: false })
        .limit(5)

      if (error) throw error
      await sendMessage(
        chatId,
        data && data.length ? '🕒 Your last 5 thoughts:\n\n' + formatThoughts(data) : 'Your brain is empty so far.',
      )
      return ok()
    }

    // /search word  or  ?word
    if (text.startsWith('/search') || text.startsWith('?')) {
      const query = text.startsWith('?') ? text.slice(1).trim() : text.slice('/search'.length).trim()

      if (!query) {
        await sendMessage(chatId, 'Add something to search for, like: /search coffee')
        return ok()
      }

      const { data, error } = await supabase
        .from('thoughts')
        .select('content, created_at')
        .eq('user_id', OWNER_USER_ID)
        .ilike('content', `%${escapeLike(query)}%`)
        .order('created_at', { ascending: false })
        .limit(5)

      if (error) throw error
      await sendMessage(
        chatId,
        data && data.length
          ? `🔎 Results for "${query}":\n\n` + formatThoughts(data)
          : `Nothing in your brain matches "${query}" yet.`,
      )
      return ok()
    }

    // Any other slash command we don't recognise → show help instead of saving it.
    if (text.startsWith('/')) {
      await sendMessage(chatId, HELP_TEXT)
      return ok()
    }

    // Everything else → save as a new thought, owned by you.
      const { error } = await supabase.from('thoughts').insert({
     user_id: OWNER_USER_ID,
     content: text,
     metadata: {
       source: 'telegram',
       telegram_chat_id: chatId,
       telegram_message_id: message.message_id,
     },
   })

    if (error) throw error
    await sendMessage(chatId, 'Saved to your brain 🧠')
  } catch (err) {
    console.error('telegram-bot error:', err)
    // Report the problem in the chat so it can be fixed, instead of failing silently.
    if (chatId) {
      const msg = err instanceof Error ? err.message : JSON.stringify(err)
      await sendMessage(chatId, `Something went wrong: ${msg}`).catch(() => {})
    }
  }

  return ok()
})