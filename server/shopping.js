// Turns recipe ingredient lines into things you'd actually buy, and merges them into
// a shopping list: "1 1/4 lb ground turkey" → "Ground turkey (2 lb)", "2 tbsp kosher salt"
// → "Kosher salt". Recipes keep their cooking measurements; only the list is converted.

const FRACTIONS = { '¼': 0.25, '½': 0.5, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': 0.125 };
const COOKING_UNITS =
  'cups?|c\\.|tablespoons?|tbsps?|tbs|tbsp|teaspoons?|tsps?|tsp|pinch(?:es)?|dash(?:es)?|cloves?|sprigs?|slices?|pieces?|handfuls?|splash(?:es)?|drizzle|stalks?|heads?|bunch(?:es)?|leaves';
const WEIGHT = { lb: ['lb', 'lbs', 'pound', 'pounds'], oz: ['oz', 'ounce', 'ounces'] };

function parseNumber(s) {
  if (!s) return null;
  let total = 0;
  let found = false;
  const range = s.match(/-\s*(\d+(?:\.\d+)?)$/);
  if (range) return Number(range[1]); // ranges "1-2" → buy the high end
  for (const part of s.trim().split(/\s+/)) {
    if (FRACTIONS[part] !== undefined) {
      total += FRACTIONS[part];
      found = true;
    } else if (/^\d+\/\d+$/.test(part)) {
      const [a, b] = part.split('/').map(Number);
      total += a / b;
      found = true;
    } else if (/^\d*\.?\d+$/.test(part)) {
      total += Number(part);
      found = true;
    } else {
      for (const ch of part) if (FRACTIONS[ch] !== undefined) (total += FRACTIONS[ch]), (found = true);
      const digits = part.match(/^\d+/);
      if (digits) (total += Number(digits[0])), (found = true);
    }
  }
  return found ? total : null;
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** Cleans an ingredient name: drops prep notes ("chopped", "to taste", "(optional)"). */
function cleanName(s) {
  return cap(
    s
      .replace(/\([^)]*\)/g, ' ')
      .replace(/,.*$/, '')
      .replace(/\b(to taste|for garnish|optional|divided|as needed|plus more.*|or more.*)\b/gi, ' ')
      .replace(/^(of|the)\s+/i, '')
      .replace(/\b(finely |freshly |roughly |thinly )?(chopped|minced|diced|sliced|grated|shredded|ground fresh)\b$/i, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/** No-AI fallback: good enough for common recipe formats. */
export function ruleBasedShopping(lines) {
  const out = [];
  for (const raw of lines) {
    let line = String(raw).trim().replace(/\s*\([^)]*\)\s*/g, ' ').trim(); // "2 (15 oz) cans" → "2 cans"
    if (!line) continue;
    // "juice of 2 limes" / "zest of 1 lemon" → the whole fruit
    const juice = line.match(/^(?:juice|zest)\s+(?:and zest\s+)?of\s+(\d+)\s+(.*)$/i);
    if (juice) line = `${juice[1]} ${juice[2]}`;
    const qty = line.match(/^(?:about\s+|approx\.?\s+)?(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?\s*[¼½¾⅓⅔⅛]|\d+(?:\.\d+)?(?:\s*-\s*\d+(?:\.\d+)?)?|[¼½¾⅓⅔⅛])\s*(.*)$/i);
    if (!qty) {
      out.push({ name: cleanName(line), amount: null });
      continue;
    }
    const n = parseNumber(qty[1]);
    const rest = qty[2];
    const unitMatch = rest.match(/^([a-z.]+)\s+(?:of\s+)?(.*)$/i);
    const unit = unitMatch?.[1]?.toLowerCase().replace(/\.$/, '');
    if (unit && new RegExp(`^(${COOKING_UNITS})$`, 'i').test(unit)) {
      out.push({ name: cleanName(unitMatch[2]), amount: null }); // pantry-style: just the item
    } else if (unit && WEIGHT.lb.includes(unit)) {
      out.push({ name: cleanName(unitMatch[2]), amount: `${Math.max(1, Math.ceil(n))} lb` });
    } else if (unit && WEIGHT.oz.includes(unit)) {
      out.push({ name: cleanName(unitMatch[2]), amount: `${Math.round(n)} oz` });
    } else if (unit && /^(cans?|jars?|packages?|pkgs?|boxes?|bags?|bottles?)$/.test(unit)) {
      const u = unit.replace(/s$/, '').replace(/^pkg$/, 'package');
      const c = Math.ceil(n || 1);
      out.push({ name: cleanName(unitMatch[2]), amount: `${c} ${c === 1 ? u : u + 's'}` });
    } else if (n) {
      out.push({ name: cleanName(rest), amount: String(Math.ceil(n)) });
    } else {
      out.push({ name: cleanName(line), amount: null });
    }
  }
  return out.filter((i) => i.name);
}

export function formatItem({ name, amount }) {
  return amount ? `${cap(name)} (${amount})` : cap(name);
}

/** Reads a list line back into { name, amount } ("Ground turkey (2 lb)" → both parts). */
export function parseListText(text) {
  const m = String(text).match(/^(.*?)\s*\(([^()]*\d[^()]*)\)\s*$/);
  return m ? { name: m[1].trim(), amount: m[2].trim() } : { name: String(text).trim(), amount: null };
}

/** Adds two amounts when they share a unit ("1 lb" + "1 lb" = "2 lb"); otherwise null. */
export function mergeAmounts(a, b) {
  if (!a || !b) return a || b || null;
  const pa = String(a).match(/^([\d.]+)\s*(.*)$/);
  const pb = String(b).match(/^([\d.]+)\s*(.*)$/);
  if (!pa || !pb) return null;
  const ua = pa[2].replace(/s$/, '');
  const ub = pb[2].replace(/s$/, '');
  if (ua !== ub) return null;
  const total = Math.round((Number(pa[1]) + Number(pb[1])) * 100) / 100;
  const unit = pa[2] ? (total === 1 ? ua : /s$/.test(pa[2]) || ['can', 'jar', 'package', 'box', 'bag', 'bottle'].includes(ua) ? `${ua}s` : pa[2]) : '';
  return `${total}${unit ? ' ' + unit : ''}`;
}

const key = (name) => name.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim().replace(/(es|s)$/, '');

/** Merges shopping items into a list's open items. Returns counts for the UI. */
export function addToList(db, listId, items) {
  const open = db.prepare('SELECT * FROM list_items WHERE list_id = ? AND done = 0').all(listId);
  const byKey = new Map(open.map((row) => [key(parseListText(row.text).name), row]));
  const ins = db.prepare('INSERT INTO list_items (list_id, text) VALUES (?, ?)');
  const upd = db.prepare('UPDATE list_items SET text = ? WHERE id = ?');
  let added = 0;
  let merged = 0;
  for (const item of items) {
    if (!item?.name) continue;
    const k = key(item.name);
    const hit = byKey.get(k);
    if (!hit) {
      const text = formatItem(item);
      const r = ins.run(listId, text.slice(0, 200));
      byKey.set(k, { id: r.lastInsertRowid, text });
      added++;
      continue;
    }
    const cur = parseListText(hit.text);
    const combined = mergeAmounts(cur.amount, item.amount);
    if (combined && combined !== cur.amount) {
      const text = formatItem({ name: cur.name, amount: combined });
      upd.run(text, hit.id);
      hit.text = text;
      merged++;
    }
  }
  return { added, merged };
}
