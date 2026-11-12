/**
 * THREADLINE — MemoryApp.jsx
 *
 * The memory page: search everything you've seen and stashed, by meaning; your
 * stash; trails (what you did, session by session); and projects (topics you
 * keep coming back to). It reads IndexedDB directly (db.js); the thinking is in
 * memory.js. The search box embeds your words with the same model as the tabs.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { getAll, remove, visitsSince, forgetSite, forgetVisits, eraseAll } from './db.js';
import { search, buildTrails, findProjects, buildSessions, dayOf, DAY_MS } from './memory.js';
import { embedTexts } from '../ml/embedder.js';
import { squirrelSvg } from '../popup/squirrel.js';

const PAUSED_KEY = 'memory_paused';     // same keys as background.js
const EXCLUDED_KEY = 'memory_excluded';
// Your names and page order for trails, keyed by when the trail started.
// shortcut: deleting a trail's first page changes its start, so its name and order are dropped; key by session if that bites.
const TRAIL_EDITS_KEY = 'trail_edits';

function duration(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
}

function ago(time) {
  const days = Math.floor((Date.now() - time) / DAY_MS);
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return new Date(time).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function dayLabel(time) {
  const today = dayOf(Date.now());
  if (dayOf(time) === today) return 'Today';
  if (dayOf(time) === dayOf(Date.now() - DAY_MS)) return 'Yesterday';
  return new Date(time).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

/** Switches to the tab showing `url`, or opens it. */
async function openUrl(url, openTabs) {
  const tab = openTabs.get(url);
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
}

/** Opens pages in a new window, in one tab group with this name. */
async function openTogether(name, urls) {
  const win = await chrome.windows.create({ url: urls, focused: true });
  const tabIds = win.tabs.map(t => t.id);
  const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId: win.id } });
  await chrome.tabGroups.update(groupId, { title: name.slice(0, 40), color: 'grey' });
}

export default function MemoryApp() {
  const [pages, setPages] = useState([]);
  const [stash, setStash] = useState([]);
  const [visits, setVisits] = useState([]);
  const [openTabs, setOpenTabs] = useState(new Map());
  const [paused, setPaused] = useState(false);
  const [view, setView] = useState('stash');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [related, setRelated] = useState(null); // { page, results } from #related=url
  const [loaded, setLoaded] = useState(false);
  const searchRun = useRef(0);

  async function load() {
    const [p, s, v, tabs, settings] = await Promise.all([
      getAll('pages'), getAll('stash'), visitsSince(Date.now() - 30 * DAY_MS), chrome.tabs.query({}),
      chrome.storage.local.get(PAUSED_KEY),
    ]);
    setPages(p || []);
    setStash((s || []).sort((a, b) => b.savedAt - a.savedAt));
    setVisits(v || []);
    setOpenTabs(new Map(tabs.map(t => [t.url.split('#')[0], t])));
    setPaused(settings[PAUSED_KEY] === true);
    setLoaded(true);
    return p || [];
  }

  useEffect(() => {
    load().then((p) => {
      const url = new URLSearchParams(location.hash.slice(1)).get('related');
      const page = url && p.find(x => x.url === url);
      if (page?.vector) setRelated({ page });
    });
  }, []);

  // Search a moment after you stop typing. The first search loads the model.
  useEffect(() => {
    const run = ++searchRun.current;
    if (!query.trim()) { setResults(null); return; }
    const timer = setTimeout(async () => {
      setSearching(true);
      const [vector] = await embedTexts([query.trim()]);
      if (run !== searchRun.current) return;
      setResults(search(vector, query, [...stash.map(r => ({ ...r, isStash: true })), ...pages]));
      setSearching(false);
    }, 300);
    return () => clearTimeout(timer);
  }, [query, pages, stash]);

  const relatedResults = useMemo(() => related
    && search(related.page.vector, '', [...stash.map(r => ({ ...r, isStash: true })), ...pages.filter(p => p.url !== related.page.url)]),
  [related, pages, stash]);

  const pageByUrl = useMemo(() => new Map(pages.map(p => [p.url, p])), [pages]);
  const trails = useMemo(() => buildTrails(visits.filter(v => v.at >= Date.now() - 7 * DAY_MS), pageByUrl), [visits, pageByUrl]);
  const projects = useMemo(() => {
    const timeByUrl = new Map();
    for (const session of buildSessions(visits)) for (const v of session.visits) timeByUrl.set(v.url, (timeByUrl.get(v.url) || 0) + v.ms);
    return findProjects(pages.filter(p => p.lastSeen >= Date.now() - 30 * DAY_MS), { timeByUrl });
  }, [pages, visits]);

  async function togglePaused() {
    await chrome.storage.local.set({ [PAUSED_KEY]: !paused });
    setPaused(!paused);
  }

  async function deleteStash(id) {
    await remove('stash', id);
    setStash(s => s.filter(item => item.id !== id));
  }

  async function neverRemember(host) {
    if (!confirm(`Forget everything from ${host}, and never remember it again? Stashed items are kept.`)) return;
    const { [EXCLUDED_KEY]: excluded = [] } = await chrome.storage.local.get(EXCLUDED_KEY);
    await chrome.storage.local.set({ [EXCLUDED_KEY]: [...new Set([...excluded, host])] });
    await forgetSite(host);
    await load();
  }

  async function erase() {
    if (!confirm('Erase every page, visit and stashed item Threadline remembers? This cannot be undone.')) return;
    await eraseAll();
    await load();
  }

  const showing = results ? 'results' : related ? 'related' : view;

  return (
    <div className="memory">
      <header className="m-header">
        <div className="m-brand">
          <span className="m-logo" aria-hidden="true" dangerouslySetInnerHTML={{ __html: squirrelSvg({ size: 32 }) }} />
          <span className="m-wordmark">Threadline</span>
          <span className="m-slash">/ Memory</span>
        </div>
        <div className="m-status">
          <span>{pages.length.toLocaleString()} pages · {stash.length} stashed</span>
          <button className="m-btn" onClick={togglePaused} aria-pressed={paused}>
            {paused ? 'Resume memory' : 'Pause memory'}
          </button>
        </div>
      </header>

      <section className="m-hero">
        <label htmlFor="m-search" className="m-eyebrow">Search everything you've seen and stashed</label>
        <input
          id="m-search"
          className="m-search"
          type="search"
          autoFocus
          placeholder="that article about squirrels forgetting…"
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
        <p className="m-hint">
          {searching ? 'Searching…' : paused
            ? 'Memory is paused: new pages are not being remembered.'
            : 'Searches by meaning, including tabs you closed. Stash a page with Alt+Shift+S, or right-click a quote or image.'}
        </p>
      </section>

      {!results && !related && (
        <nav className="m-tabs" aria-label="Memory">
          {[['stash', 'Stash', stash.length], ['trails', 'Trails', trails.length], ['projects', 'Projects', projects.length]].map(([id, label, count]) => (
            <button key={id} className={`m-tab ${view === id ? 'm-tab-on' : ''}`} aria-current={view === id} onClick={() => setView(id)}>
              {label} <span className="m-count">{count}</span>
            </button>
          ))}
        </nav>
      )}

      <main className="m-main">
        {showing === 'results' && (
          <ResultList title={`${results.length} result${results.length === 1 ? '' : 's'}`} results={results}
            openTabs={openTabs} onDelete={deleteStash} onNever={neverRemember} />
        )}
        {showing === 'related' && (
          <>
            <button className="m-link" onClick={() => { setRelated(null); history.replaceState(null, '', location.pathname); }}>← All memory</button>
            <ResultList title={`Related to “${related.page.title}”`} results={relatedResults}
              openTabs={openTabs} onDelete={deleteStash} onNever={neverRemember} />
          </>
        )}
        {showing === 'stash' && <StashGrid stash={stash} loaded={loaded} openTabs={openTabs} onDelete={deleteStash} />}
        {showing === 'trails' && <Trails trails={trails} loaded={loaded} openTabs={openTabs} onChanged={load} />}
        {showing === 'projects' && <Projects projects={projects} loaded={loaded} openTabs={openTabs} />}
      </main>

      <footer className="m-footer">
        <p>Your memory stays on this computer. Incognito tabs are never remembered, and pages you haven't seen for 90 days are forgotten. Stashed items stay until you delete them.</p>
        <button className="m-btn m-btn-quiet" onClick={erase}>Erase memory</button>
      </footer>
    </div>
  );
}

function Empty({ children }) {
  return <p className="m-empty">{children}</p>;
}

function ResultList({ title, results, openTabs, onDelete, onNever }) {
  return (
    <section>
      <h2 className="m-h2">{title}</h2>
      {results.length === 0 && <Empty>Nothing close enough. Try other words: it matches meaning, not just exact words.</Empty>}
      <ol className="m-results">
        {results.map(({ record }) => {
          const open = openTabs.has(record.url);
          const when = record.isStash ? `stashed ${ago(record.savedAt)}` : open ? 'open now' : `seen ${ago(record.lastSeen)}`;
          return (
            <li key={record.isStash ? record.id : record.url} className="m-result">
              <button className="m-result-main" onClick={() => openUrl(record.url, openTabs)}>
                {record.kind === 'image' && <img className="m-thumb" src={record.imageUrl} alt="" loading="lazy" />}
                <span className="m-result-title">{record.kind === 'quote' ? `“${record.quote}”` : record.title || record.url}</span>
                <span className="m-meta">
                  {record.isStash && <span className="m-acorn" aria-label="Stashed" />}
                  {record.host || hostOf(record.url)} · {record.category || 'Uncategorised'} · <span className={open ? 'm-open' : ''}>{when}</span>
                </span>
              </button>
              {record.isStash
                ? <button className="m-x" onClick={() => onDelete(record.id)} aria-label="Delete from stash">Delete</button>
                : <button className="m-x" onClick={() => onNever(record.host || hostOf(record.url))}>Never remember this site</button>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function StashGrid({ stash, loaded, openTabs, onDelete }) {
  if (loaded && stash.length === 0) {
    return <Empty>Nothing stashed yet. On any page, press Alt+Shift+S to stash it, or highlight text first to stash a quote. Right-click an image to stash it.</Empty>;
  }
  return (
    <div className="m-grid">
      {stash.map(item => (
        <article key={item.id} className={`m-card m-card-${item.kind}`}>
          <button className="m-card-open" onClick={() => openUrl(item.url, openTabs)}>
            {item.kind === 'image' && <img src={item.imageUrl} alt={item.title} loading="lazy" />}
            {item.kind === 'quote' && <blockquote>{item.quote}</blockquote>}
            {item.kind === 'page' && (
              <>
                <h3>{item.title || item.url}</h3>
                {item.text && <p>{item.text.slice(0, 180)}{item.text.length > 180 ? '…' : ''}</p>}
              </>
            )}
          </button>
          <footer>
            <span className="m-meta">
              {item.favIconUrl && <img className="m-fav" src={item.favIconUrl} alt="" />}
              {item.host} · {item.category || 'Sorting…'} · {ago(item.savedAt)}
            </span>
            <button className="m-x" onClick={() => onDelete(item.id)} aria-label={`Delete ${item.title} from stash`}>Delete</button>
          </footer>
        </article>
      ))}
    </div>
  );
}

function PageList({ pages, openTabs }) {
  return (
    <ul className="m-pages">
      {pages.map(p => (
        <li key={p.url}>
          <button onClick={() => openUrl(p.url, openTabs)}>
            <span>{p.title || p.url}</span>
            <span className="m-meta">{p.host || hostOf(p.url)}{openTabs.has(p.url) && <span className="m-open"> · open</span>}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function Chevron({ up }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d={up ? 'M3 9l4-4 4 4' : 'M3 5l4 4 4-4'} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** A trail with your name and page order applied. */
function edited(trail, edit) {
  if (!edit) return trail;
  const rank = (p) => { const i = edit.order?.indexOf(p.key) ?? -1; return i < 0 ? Infinity : i; };
  return { ...trail, name: edit.name || trail.name, pages: [...trail.pages].sort((a, b) => rank(a) - rank(b)) };
}

function Trails({ trails: found, loaded, openTabs, onChanged }) {
  const [openKey, setOpenKey] = useState(null);
  const [edits, setEdits] = useState({});
  useEffect(() => { chrome.storage.local.get(TRAIL_EDITS_KEY).then(r => setEdits(r[TRAIL_EDITS_KEY] || {})); }, []);

  async function saveEdit(key, change) {
    const next = { ...edits, [key]: { ...edits[key], ...change } };
    setEdits(next);
    await chrome.storage.local.set({ [TRAIL_EDITS_KEY]: next });
  }

  function rename(trail) {
    const name = prompt('Name this trail', trail.name);
    if (name?.trim()) saveEdit(trail.start, { name: name.trim().slice(0, 60) });
  }

  function move(trail, index, by) {
    const order = trail.pages.map(p => p.key);
    [order[index], order[index + by]] = [order[index + by], order[index]];
    saveEdit(trail.start, { order });
  }

  async function forget(trail, pages) {
    const what = pages.length === trail.pages.length ? `the trail "${trail.name}"` : `"${pages[0].title || hostOf(pages[0].url)}" from this trail`;
    if (!confirm(`Delete ${what}? The pages stay searchable; only these visits are forgotten.`)) return;
    await forgetVisits(pages.flatMap(p => p.urls), trail.start, trail.end);
    await onChanged();
  }

  if (loaded && found.length === 0) {
    return <Empty>No trails yet. As you browse, Threadline links the pages you move between into trails, one per thing you were doing.</Empty>;
  }
  let lastDay = null;
  return (
    <div className="m-list">
      {found.map((raw) => {
        const trail = edited(raw, edits[raw.start]);
        const isOpen = openKey === trail.start;
        const day = dayLabel(trail.start);
        const heading = day !== lastDay ? <h2 className="m-h2">{day}</h2> : null;
        lastDay = day;
        return (
          <React.Fragment key={trail.start}>
            {heading}
            <article className="m-row">
              <div className="m-row-head">
                <button className="m-row-title" onClick={() => setOpenKey(isOpen ? null : trail.start)} aria-expanded={isOpen}>
                  <span className="m-time">{new Date(trail.start).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>
                  <span className="m-name">{trail.name}</span>
                </button>
                <div className="m-row-actions">
                  <button className="m-btn m-btn-quiet" onClick={() => rename(trail)}>Rename</button>
                  <button className="m-btn m-btn-quiet m-btn-danger" onClick={() => forget(trail, trail.pages)}>Delete</button>
                  <button className="m-btn" onClick={() => openTogether(trail.name, trail.pages.map(p => p.url))}>
                    Reopen {trail.pages.length} page{trail.pages.length === 1 ? '' : 's'}
                  </button>
                </div>
              </div>
              <p className="m-meta">
                {duration(trail.ms)} · {trail.steps.length > trail.pages.length ? `${trail.steps.length} steps across ` : ''}{trail.pages.length} page{trail.pages.length === 1 ? '' : 's'}
                {trail.category && ` · ${trail.category}`} · ended at {trail.endsAt.title || hostOf(trail.endsAt.url)}
              </p>
              {isOpen && (
                <div className="m-trail">
                  <section>
                    <h3 className="m-h2">Your path</h3>
                    <ol className="m-path">
                      {trail.steps.map((step, i) => (
                        <li key={i} className={step.back ? 'm-step-back' : ''}>
                          <span className="m-time">{new Date(step.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>
                          <span>{step.back && <span className="m-back">back to </span>}{step.title || hostOf(step.url)}</span>
                        </li>
                      ))}
                    </ol>
                  </section>
                  <section>
                    <h3 className="m-h2">Pages, in the order Reopen opens them</h3>
                    <ul className="m-pages">
                      {trail.pages.map((p, i) => (
                        <li key={p.key} className="m-page-row">
                          <button onClick={() => openUrl(p.url, openTabs)}>
                            <span>{p.title || p.url}</span>
                            <span className="m-meta">{p.host || hostOf(p.url)}{openTabs.has(p.url) && <span className="m-open"> · open</span>}</span>
                          </button>
                          <span className="m-page-tools">
                            <button aria-label={`Move ${p.title} up`} disabled={i === 0} onClick={() => move(trail, i, -1)}><Chevron up /></button>
                            <button aria-label={`Move ${p.title} down`} disabled={i === trail.pages.length - 1} onClick={() => move(trail, i, 1)}><Chevron /></button>
                            <button aria-label={`Remove ${p.title} from this trail`} className="m-x-on" onClick={() => forget(trail, [p])}>Remove</button>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </section>
                </div>
              )}
            </article>
          </React.Fragment>
        );
      })}
    </div>
  );
}

function Projects({ projects, loaded, openTabs }) {
  const [openIndex, setOpenIndex] = useState(null);
  if (loaded && projects.length === 0) {
    return <Empty>No projects yet. When you keep coming back to the same topic on different days, Threadline gathers those pages into a project for you.</Empty>;
  }
  return (
    <div className="m-list">
      {projects.map((project, i) => (
        <article key={project.name + i} className="m-row">
          <div className="m-row-head">
            <button className="m-row-title" onClick={() => setOpenIndex(openIndex === i ? null : i)} aria-expanded={openIndex === i}>
              <span className="m-name">{project.name}</span>
            </button>
            <button className="m-btn" onClick={() => openTogether(project.name, project.pages.slice(0, 20).map(p => p.url))}>
              Open {Math.min(project.pages.length, 20)} pages
            </button>
          </div>
          <p className="m-meta">
            {project.pages.length} pages over {project.days} days
            {project.ms > 0 && ` · ${duration(project.ms)}`}
            {project.category && ` · ${project.category}`} · last {ago(project.lastSeen)}
          </p>
          {openIndex === i && <PageList pages={project.pages} openTabs={openTabs} />}
        </article>
      ))}
    </div>
  );
}
