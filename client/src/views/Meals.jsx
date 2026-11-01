import { useState } from 'react';
import { IconChevronLeft, IconChevronRight, IconShoppingCartPlus, IconToolsKitchen2, IconBook, IconPlus, IconSparkles, IconTrash, IconLink, IconPencil } from '@tabler/icons-react';
import { api, useLive } from '../api.js';
import { addDays, dayKey, fmt, fromKey, sameDay, startOfWeek } from '../dates.js';
import { Modal, toast, toastError } from '../components/ui.jsx';

function RecipeEditor({ recipe, aiEnabled, onClose }) {
  const [f, setF] = useState(
    recipe ? { ...recipe, ingredients: recipe.ingredients.join('\n') } : { title: '', ingredients: '', instructions: '', source_url: '' }
  );
  const [importUrl, setImportUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF({ ...f, [k]: v });
  const doImport = async () => {
    if (!importUrl.trim()) return;
    setBusy(true);
    try {
      const looksLikeUrl = /^https?:\/\//i.test(importUrl.trim());
      const r = await api('POST', '/api/recipes/import', looksLikeUrl ? { url: importUrl.trim() } : { text: importUrl });
      setF({ title: r.title, ingredients: r.ingredients.join('\n'), instructions: r.instructions, source_url: r.source_url || '' });
      toast('Recipe read — check it and save', 'success');
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const save = async (e) => {
    e.preventDefault();
    try {
      const body = { ...f, ingredients: f.ingredients.split('\n') };
      if (recipe) await api('PUT', `/api/recipes/${recipe.id}`, body);
      else await api('POST', '/api/recipes', body);
      toast('Recipe saved', 'success');
      onClose();
    } catch (err) {
      toastError(err);
    }
  };
  const remove = async () => {
    try {
      await api('DELETE', `/api/recipes/${recipe.id}`);
      onClose();
    } catch (err) {
      toastError(err);
    }
  };
  return (
    <Modal title={recipe ? recipe.title : 'New recipe'} onClose={onClose} wide>
      {aiEnabled && !recipe && (
        <div className="add-row">
          <input value={importUrl} onChange={(e) => setImportUrl(e.target.value)} placeholder="Paste a recipe link (or the recipe text)" aria-label="Recipe link" />
          <button className="btn" onClick={doImport} disabled={busy}>
            <IconSparkles size={18} className={busy ? 'spin' : ''} /> {busy ? 'Reading…' : 'Import'}
          </button>
        </div>
      )}
      <form className="form" onSubmit={save}>
        <label>
          Name
          <input value={f.title} onChange={(e) => set('title', e.target.value)} placeholder="Chicken tacos" required />
        </label>
        <label>
          Ingredients (one per line)
          <textarea rows={7} value={f.ingredients} onChange={(e) => set('ingredients', e.target.value)} />
        </label>
        <label>
          Steps
          <textarea rows={7} value={f.instructions || ''} onChange={(e) => set('instructions', e.target.value)} />
        </label>
        {f.source_url && (
          <a className="hint" href={f.source_url} target="_blank" rel="noreferrer">
            <IconLink size={14} /> {f.source_url}
          </a>
        )}
        <div className="form-actions">
          {recipe && (
            <button type="button" className="btn ghost danger" onClick={remove}>
              <IconTrash size={18} /> Delete
            </button>
          )}
          <span className="grow" />
          <button className="btn primary">Save recipe</button>
        </div>
      </form>
    </Modal>
  );
}

/** "1. Brown the turkey\n2. …" → ['Brown the turkey', …] */
function steps(text) {
  return String(text || '')
    .split(/\n+/)
    .map((l) => l.replace(/^\s*(step\s*)?\d+[.):]\s*/i, '').trim())
    .filter(Boolean);
}

function RecipePanel({ meal }) {
  const list = steps(meal.recipe_instructions);
  return (
    <section className="recipe-panel">
      <h3 className="panel-title">
        <IconBook size={20} /> How to make it
      </h3>
      {meal.recipe_ingredients?.length > 0 && (
        <>
          <h4 className="subhead">Ingredients</h4>
          <ul className="recipe-ingredients">
            {meal.recipe_ingredients.map((i, n) => (
              <li key={n}>{i}</li>
            ))}
          </ul>
        </>
      )}
      <h4 className="subhead">Steps</h4>
      {list.length ? (
        <ol className="recipe-steps">
          {list.map((st, n) => (
            <li key={n}>{st}</li>
          ))}
        </ol>
      ) : (
        <p className="muted small">No steps saved for this recipe — add them in the Recipe box.</p>
      )}
      {meal.recipe_source && (
        <a className="hint" href={meal.recipe_source} target="_blank" rel="noreferrer">
          <IconLink size={14} /> Original recipe
        </a>
      )}
    </section>
  );
}

function MealEditor({ date, meal, onClose }) {
  const { data: recipes } = useLive('/api/recipes', ['recipes']);
  const [title, setTitle] = useState(meal?.title || '');
  const [notes, setNotes] = useState(meal?.notes || '');
  const [ingredients, setIngredients] = useState((meal?.ingredients || []).join('\n'));
  const [editing, setEditing] = useState(!meal?.recipe_id);
  const pickRecipe = async (id) => {
    if (!id) return;
    try {
      await api('POST', `/api/meals/${date}/recipe`, { recipe_id: Number(id) });
      const r = recipes.find((x) => x.id === Number(id));
      if (r) {
        setTitle(r.title);
        setIngredients(r.ingredients.join('\n'));
      }
      setEditing(false); // show the recipe right away; the day stays open
      toast('Dinner set from recipe', 'success');
    } catch (e) {
      toastError(e);
    }
  };
  const save = async (e) => {
    e.preventDefault();
    try {
      const body = { title, notes, ingredients: ingredients.split('\n') };
      // Retyped the dinner as something else? Then the old recipe no longer applies.
      if (meal?.recipe_id && title.trim() !== meal.recipe_title) body.recipe_id = null;
      await api('PUT', `/api/meals/${date}`, body);
      toast(title.trim() ? 'Dinner saved' : 'Dinner cleared', 'success');
      onClose();
    } catch (err) {
      toastError(err);
    }
  };
  const hasRecipe = Boolean(meal?.recipe_id && meal?.recipe_title);
  return (
    <Modal title={`Dinner · ${fmt.long(fromKey(date))}`} onClose={onClose} wide={hasRecipe}>
      {hasRecipe && !editing && (
        <>
          <div className="meal-summary">
            <p className="dinner">{meal.title}</p>
            {meal.notes && <span className="note-chip">{meal.notes}</span>}
          </div>
          <RecipePanel meal={meal} />
          <div className="form-actions">
            <button type="button" className="btn" onClick={() => setEditing(true)}>
              <IconPencil size={18} /> Edit dinner
            </button>
          </div>
        </>
      )}
      {editing && (
        <>
          {recipes?.length > 0 && (
            <label className="form" style={{ marginBottom: 14 }}>
              <span className="label">From the recipe box</span>
              <select defaultValue="" onChange={(e) => pickRecipe(e.target.value)}>
                <option value="">Pick a recipe…</option>
                {recipes.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          <form className="form" onSubmit={save}>
            <label>
              What’s for dinner
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Chicken tacos" autoFocus={!meal} />
            </label>
            <label>
              Notes
              <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Casey helps cook" />
            </label>
            <label>
              Ingredients (one per line)
              <textarea rows={6} value={ingredients} onChange={(e) => setIngredients(e.target.value)} placeholder={'Tortillas\nCilantro\nLimes'} />
            </label>
            <div className="form-actions">
              {meal && (
                <button type="button" className="btn ghost" onClick={() => setTitle('')}>
                  Clear
                </button>
              )}
              <button className="btn primary">Save</button>
            </div>
          </form>
        </>
      )}
    </Modal>
  );
}

export default function Meals({ now, aiEnabled }) {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(now));
  const [editing, setEditing] = useState(null);
  const [recipe, setRecipe] = useState(null); // null | 'new' | recipe
  const recipes = useLive('/api/recipes', ['recipes']);
  const from = dayKey(weekStart);
  const to = dayKey(addDays(weekStart, 6));
  const { data } = useLive(`/api/meals?from=${from}&to=${to}`, ['meals']);
  const byDate = Object.fromEntries((data || []).map((m) => [m.date, m]));
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  const toList = async (date) => {
    try {
      const r = await api('POST', `/api/meals/${date}/to-list`, {});
      toast(r.added ? `Added ${r.added} item${r.added === 1 ? '' : 's'} to groceries` : 'Everything’s already on the list', 'success');
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <div className="meals">
      <div className="toolbar">
        <button className="icon-btn" onClick={() => setWeekStart(addDays(weekStart, -7))} aria-label="Previous week">
          <IconChevronLeft />
        </button>
        <h2 className="toolbar-title">
          {fmt.short(weekStart)} – {fmt.short(addDays(weekStart, 6))}
        </h2>
        <button className="icon-btn" onClick={() => setWeekStart(addDays(weekStart, 7))} aria-label="Next week">
          <IconChevronRight />
        </button>
        <button className="btn" onClick={() => setWeekStart(startOfWeek(now))}>
          This week
        </button>
      </div>
      <div className="meal-grid">
        {days.map((d) => {
          const key = dayKey(d);
          const meal = byDate[key];
          return (
            <div key={key} className={`meal-card ${sameDay(d, now) ? 'is-today' : ''}`}>
              <button className="meal-main" onClick={() => setEditing(key)}>
                <span className="meal-day">{fmt.weekday(d)}</span>
                <span className="date-num">{d.getDate()}</span>
                {meal ? (
                  <>
                    <span className="meal-title">{meal.title}</span>
                    {meal.notes && <span className="muted small">{meal.notes}</span>}
                    {meal.recipe_id ? (
                      <span className="recipe-tag">
                        <IconBook size={14} /> Recipe
                      </span>
                    ) : (
                      meal.ingredients.length > 0 && <span className="muted small">{meal.ingredients.length} ingredients</span>
                    )}
                  </>
                ) : (
                  <span className="meal-empty">
                    <IconToolsKitchen2 size={22} stroke={1.5} /> Plan dinner
                  </span>
                )}
              </button>
              {meal?.ingredients.length > 0 && (
                <button className="btn ghost small-btn" onClick={() => toList(key)}>
                  <IconShoppingCartPlus size={18} /> Add to groceries
                </button>
              )}
            </div>
          );
        })}
      </div>
      <section className="panel recipe-box">
        <div className="section-head">
          <h3 className="panel-title">
            <IconBook size={20} /> Recipe box
          </h3>
          <button className="btn small-btn" onClick={() => setRecipe('new')}>
            <IconPlus size={18} /> Add recipe
          </button>
        </div>
        {!recipes.data?.length ? (
          <p className="muted small">Save family favorites here{aiEnabled ? ' — or import one from any recipe website' : ''}, then pick them when planning dinner.</p>
        ) : (
          <div className="recipe-chips">
            {recipes.data.map((r) => (
              <button key={r.id} className="recipe-chip" onClick={() => setRecipe(r)}>
                {r.title}
                <span className="muted small">{r.ingredients.length} ingredients</span>
              </button>
            ))}
          </div>
        )}
      </section>
      {editing && <MealEditor date={editing} meal={byDate[editing]} onClose={() => setEditing(null)} />}
      {recipe && <RecipeEditor recipe={recipe === 'new' ? null : recipe} aiEnabled={aiEnabled} onClose={() => setRecipe(null)} />}
    </div>
  );
}
