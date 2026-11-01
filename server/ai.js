// AI parsing for quick-add and recipe import, through any OpenAI-compatible Chat Completions
// API: OpenAI by default, or OPENAI_BASE_URL for OpenRouter, Groq, Ollama, LM Studio, etc.
// Uses a strict JSON schema so replies are always well-formed.

export function aiBaseUrl() {
  return (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
}

export function aiModel() {
  return process.env.OPENAI_MODEL || 'gpt-5-mini';
}

/** On with an API key, or with a custom base URL alone (local servers usually need no key). */
export function aiEnabled() {
  return Boolean(process.env.OPENAI_API_KEY || process.env.OPENAI_BASE_URL);
}

const nullable = (type) => ({ type: [type, 'null'] });

const ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'title', 'person', 'date', 'start_time', 'end_time', 'all_day', 'location', 'ingredients', 'points', 'repeat', 'repeat_until', 'days'],
  properties: {
    type: { type: 'string', enum: ['event', 'chore', 'task', 'grocery', 'meal', 'note', 'countdown'] },
    title: { type: 'string', description: 'Short title. For grocery: the item name.' },
    person: { ...nullable('string'), description: 'Exact household name this belongs to, or null.' },
    date: { ...nullable('string'), description: 'YYYY-MM-DD. Events, task due dates, meals, countdowns.' },
    start_time: { ...nullable('string'), description: '24h HH:MM for timed events.' },
    end_time: { ...nullable('string'), description: '24h HH:MM, or null to default to one hour.' },
    all_day: { type: 'boolean' },
    location: nullable('string'),
    ingredients: { type: 'array', items: { type: 'string' }, description: 'Only for meals; otherwise empty.' },
    points: { ...nullable('integer'), description: 'Only if a task explicitly offers points.' },
    repeat: { type: 'string', enum: ['none', 'daily', 'weekly', 'biweekly', 'monthly'], description: 'Events only: how it repeats ("every Tuesday" = weekly). Otherwise none.' },
    repeat_until: { ...nullable('string'), description: 'YYYY-MM-DD last date of a repeating event, if stated.' },
    days: { type: 'array', items: { type: 'integer' }, description: 'Chores only: weekdays it is due, 0=Sunday … 6=Saturday. Empty = every day.' },
  },
};

const QUICK_ADD_SCHEMA = {
  name: 'quick_add',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['items'],
    properties: { items: { type: 'array', items: ITEM_SCHEMA } },
  },
};

const RECIPE_SCHEMA = {
  name: 'recipe',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'ingredients', 'instructions'],
    properties: {
      title: { type: 'string' },
      ingredients: { type: 'array', items: { type: 'string' }, description: 'One ingredient per entry, with quantity.' },
      instructions: { type: 'string', description: 'Numbered steps, one per line.' },
    },
  },
};

async function complete(fetchImpl, messages, schema) {
  if (!aiEnabled()) throw Object.assign(new Error('AI is not set up — add OPENAI_API_KEY (or OPENAI_BASE_URL) to .env'), { status: 503 });
  const model = aiModel();
  const body = { model, messages, response_format: { type: 'json_schema', json_schema: schema } };
  // gpt-5 family models reason by default; minimal effort keeps quick-add fast and cheap.
  const effort = process.env.OPENAI_REASONING_EFFORT ?? (model.startsWith('gpt-5') ? 'minimal' : '');
  if (effort) body.reasoning_effort = effort;

  const call = (payload) =>
    fetchImpl(`${aiBaseUrl()}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(process.env.OPENAI_API_KEY ? { authorization: `Bearer ${process.env.OPENAI_API_KEY}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60000),
    });
  let res = await call(body);
  if (res.status === 400 && body.reasoning_effort) {
    // Some models reject reasoning_effort; retry once without it.
    const detail = await res.text();
    if (/reasoning/i.test(detail)) {
      delete body.reasoning_effort;
      res = await call(body);
    } else {
      throw Object.assign(new Error(`AI request rejected: ${detail.slice(0, 200)}`), { status: 502 });
    }
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const msg = res.status === 401 ? 'The AI provider rejected the API key' : `AI request failed (${res.status})`;
    console.error('AI provider error', res.status, detail.slice(0, 500));
    throw Object.assign(new Error(msg), { status: 502 });
  }
  const data = await res.json();
  const choice = data.choices?.[0]?.message;
  if (choice?.refusal) throw Object.assign(new Error('The AI declined to read that'), { status: 422 });
  return parseJsonReply(choice?.content);
}

/** Some local models wrap JSON in a ```json fence even when asked for strict JSON. */
export function parseJsonReply(content) {
  const text = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error('The AI reply wasn’t valid JSON — try a model that supports structured output'), { status: 502 });
  }
}

export function quickAddPrompt({ today, weekday, timezone, people, lists }) {
  const household = people
    .map((p) => `${p.name} (${p.role === 'calendar' ? 'shared family calendar' : p.role}${p.birthday ? `, born ${p.birthday}` : ''})`)
    .join('; ');
  return [
    'You turn quick notes, messages, and photos (flyers, permission slips, school emails, recipes) into items for a family hub.',
    `Today is ${weekday} ${today}; timezone ${timezone}. Resolve relative dates ("Thursday", "next week") from today.`,
    `Household: ${household}. "Mom" means the adult woman, "Dad" the adult man. Use exact names from this list for "person".`,
    'Use person "Family" (if present) for events involving everyone. Groceries never need a person.',
    `Lists: ${lists.join(', ')}. Anything to buy becomes a "grocery" item (one item per thing).`,
    'Types: event = something happening at a time/date; chore = a recurring household job someone is responsible for (anything described as a chore, or "every day"/"on Mondays" jobs like dishes, trash, feeding pets);',
    'task = a one-off to-do (optionally with a due date); meal = dinner plan for a date;',
    'If the user says "chore", always use type chore — never task. Chores get points only if stated (else null).',
    'note = a message to post on the board; countdown = a big upcoming occasion worth counting down to (trips, holidays).',
    'Recurring events ("every Tuesday night", "Mondays and Wednesdays") use repeat; date = the next occurrence. For several weekdays, create one weekly event per weekday.',
    'Only create what the input actually asks for. If nothing actionable, return an empty list.',
  ].join('\n');
}

export async function parseQuickAdd(fetchImpl, { text, image, images = [], context }) {
  const content = [];
  if (text) content.push({ type: 'text', text });
  for (const url of [...(image ? [image] : []), ...images].slice(0, 4)) {
    content.push({ type: 'image_url', image_url: { url, detail: 'high' } });
  }
  if (!content.length) throw Object.assign(new Error('Type something or add a photo'), { status: 400 });
  const out = await complete(fetchImpl, [{ role: 'system', content: quickAddPrompt(context) }, { role: 'user', content }], QUICK_ADD_SCHEMA);
  return out.items || [];
}

export async function extractRecipe(fetchImpl, { text, url, fetchPage }) {
  let source = text || '';
  if (url) source = htmlToText(await fetchPage(url));
  if (!source.trim()) throw Object.assign(new Error('Paste a recipe link or the recipe text'), { status: 400 });
  return complete(
    fetchImpl,
    [
      { role: 'system', content: 'Extract the recipe from this page or text. Ignore ads, stories, and comments.' },
      { role: 'user', content: source.slice(0, 24000) },
    ],
    RECIPE_SCHEMA
  );
}

export function htmlToText(html) {
  // Recipe sites embed schema.org JSON-LD; prefer it when present — it's compact and exact.
  const ld = [...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  const recipeLd = ld.find((j) => /"@type"\s*:\s*"?\[?\s*"?Recipe/i.test(j));
  if (recipeLd) return recipeLd;
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

const SHOPPING_SCHEMA = {
  name: 'shopping',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['items'],
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'amount'],
          properties: {
            name: { type: 'string', description: 'What to look for in the store, capitalized, no prep words. e.g. "Ground turkey", "Kosher salt".' },
            amount: { ...nullable('string'), description: 'Purchasable amount like "2 lb", "3", "2 cans", or null for pantry staples.' },
          },
        },
      },
    },
  },
};

/** Recipe ingredient lines → a grocery list a shopper can use. */
export async function shoppingItems(fetchImpl, ingredients) {
  const out = await complete(
    fetchImpl,
    [
      {
        role: 'system',
        content: [
          'Convert recipe ingredients into a grocery shopping list (US store).',
          'Rules:',
          '- Meat, poultry, fish: round UP to whole pounds as sold, e.g. "1 1/4 lb ground turkey" → Ground turkey, "2 lb". Ounces of meat → round up to pounds.',
          '- Produce: a whole-item count ("juice of 2 limes" → Limes, "2"; "3 cloves garlic" → Garlic, null; "1/2 onion" → Onion, "1").',
          '- Cans, jars, boxes, bags: count of containers ("2 (15 oz) cans black beans" → Black beans, "2 cans").',
          '- Spices, salt, pepper, oils, vinegars, condiments, sauces, baking staples, anything measured in tsp/tbsp/cups/pinches: name only, amount null.',
          '- Bread, buns, tortillas, wraps: by package ("8 flour tortillas" → Flour tortillas, "1 package"). Eggs: by dozen ("3 eggs" → Eggs, "1 dozen").',
          '- Dairy by container when sensible ("2 cups milk" → Milk, null; "8 oz cream cheese" → Cream cheese, "8 oz").',
          '- Drop prep words (chopped, minced, divided, to taste, optional). Keep useful variety words (light mayonnaise, low-sodium soy sauce).',
          '- Merge duplicates. Skip water and ice.',
        ].join('\n'),
      },
      { role: 'user', content: ingredients.join('\n').slice(0, 8000) },
    ],
    SHOPPING_SCHEMA
  );
  return out.items || [];
}
