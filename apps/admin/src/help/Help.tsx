import { Fragment, ReactNode, useMemo, useState } from 'react';
import { AREAS, HelpTopic, TOPICS, topicsForPage } from './content';

const BASE = import.meta.env.BASE_URL;
const norm = (s: string) => s.toLocaleLowerCase('sr').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'dj');

/** **podebljano** i `dugme` u tekstu */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((p, i) =>
    p.startsWith('**') ? <strong key={i}>{p.slice(2, -2)}</strong>
      : p.startsWith('`') ? <kbd key={i} className="help-key">{p.slice(1, -1)}</kbd>
        : <Fragment key={i}>{p}</Fragment>);
}

/** Telo teme: podnaslovi, liste, koraci, saveti, slike (vidi content.ts). */
export function TopicBody({ t }: { t: HelpTopic }) {
  const out: ReactNode[] = [];
  let list: { kind: 'ul' | 'ol'; items: string[] } | null = null;
  const flush = () => {
    if (!list) return;
    const L = list.kind;
    out.push(<L key={out.length} className="help-list">{list.items.map((x, i) => <li key={i}>{inline(x)}</li>)}</L>);
    list = null;
  };
  for (const line of t.body) {
    const ol = /^\d+\.\s+(.*)$/.exec(line);
    if (line.startsWith('- ') || ol) {
      const kind = ol ? 'ol' : 'ul';
      if (list && list.kind !== kind) flush();
      list ??= { kind, items: [] };
      list.items.push(ol ? ol[1] : line.slice(2));
      continue;
    }
    flush();
    if (line.startsWith('# ')) out.push(<h4 key={out.length}>{line.slice(2)}</h4>);
    else if (line.startsWith('! ')) out.push(<div key={out.length} className="help-tip">{inline(line.slice(2))}</div>);
    else if (line.startsWith('img:')) {
      const [file, caption] = line.slice(4).split('|');
      out.push(
        <figure key={out.length} className="help-fig">
          <img src={`${BASE}help/${file}`} alt={caption ?? ''} loading="lazy" onError={(e) => { (e.currentTarget.parentElement as HTMLElement).style.display = 'none'; }} />
          {caption && <figcaption>{caption}</figcaption>}
        </figure>,
      );
    } else out.push(<p key={out.length}>{inline(line)}</p>);
  }
  flush();
  return <>{out}</>;
}

/** Celo uputstvo: sadržaj levo (kasa, ADMIN, KDS, instalacija), pretraga, tekst sa slikama desno, štampa. */
export function HelpPage({ initial }: { initial?: string }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(initial ?? TOPICS[0].id);
  const found = useMemo(() => {
    const t = norm(q.trim());
    return t ? TOPICS.filter((x) => norm(`${x.title} ${x.body.join(' ')}`).includes(t)) : TOPICS;
  }, [q]);
  const topic = TOPICS.find((t) => t.id === sel) ?? TOPICS[0];
  const idx = TOPICS.indexOf(topic);
  return (
    <div className="page wide help-page">
      <aside className="help-toc">
        <input className="input" value={q} placeholder="Pretraži uputstvo… (npr. storno, PIN, faktura)" onChange={(e) => setQ(e.target.value)} />
        {AREAS.map((a) => {
          const ts = found.filter((t) => t.area === a.id);
          if (!ts.length) return null;
          return (
            <div key={a.id} className="help-area">
              <div className="help-area-title">{a.title}</div>
              {ts.map((t) => <button key={t.id} className={t.id === topic.id ? 'on' : ''} onClick={() => setSel(t.id)}>{t.title}</button>)}
            </div>
          );
        })}
        {found.length === 0 && <p className="muted small">Ništa za „{q}“.</p>}
        <button className="btn sm" onClick={() => window.print()} title="Celo uputstvo na papiru ili u PDF">Štampaj celo uputstvo</button>
      </aside>
      <article className="help-article">
        <div className="help-crumb">{AREAS.find((a) => a.id === topic.area)?.title}</div>
        <h2>{topic.title}</h2>
        <TopicBody t={topic} />
        <div className="help-nav">
          {idx > 0 && <button className="btn" onClick={() => setSel(TOPICS[idx - 1].id)}>← {TOPICS[idx - 1].title}</button>}
          <span />
          {idx < TOPICS.length - 1 && <button className="btn" onClick={() => setSel(TOPICS[idx + 1].id)}>{TOPICS[idx + 1].title} →</button>}
        </div>
      </article>
      {/* štampa: sve teme redom */}
      <div className="help-print" aria-hidden>
        <h1>Uputstvo - POS kasa</h1>
        {AREAS.map((a) => (
          <section key={a.id}>
            <h2>{a.title}</h2><p>{a.intro}</p>
            {TOPICS.filter((t) => t.area === a.id).map((t) => <div key={t.id} className="help-print-topic"><h3>{t.title}</h3><TopicBody t={t} /></div>)}
          </section>
        ))}
      </div>
    </div>
  );
}

/** Dugme "?" (gore desno): objašnjenje trenutne stranice u bočnom panelu. */
export function HelpDrawer({ page, onClose, onOpenAll }: { page: string; onClose: () => void; onOpenAll: (topicId?: string) => void }) {
  const ts = topicsForPage(page);
  return (
    <div className="help-drawer-back" onMouseDown={onClose}>
      <aside className="help-drawer" onMouseDown={(e) => e.stopPropagation()} aria-label="Uputstvo za ovu stranicu">
        <div className="help-drawer-head">
          <b>Uputstvo</b>
          <button className="btn ghost sm" onClick={onClose} aria-label="Zatvori">✕</button>
        </div>
        {ts.length === 0
          ? <p className="muted">Za ovu stranicu još nema posebnog uputstva.</p>
          : ts.map((t) => <section key={t.id}><h3>{t.title}</h3><TopicBody t={t} /></section>)}
        <button className="btn primary" onClick={() => onOpenAll(ts[0]?.id)}>Celo uputstvo (kasa, ADMIN, KDS)</button>
      </aside>
    </div>
  );
}
