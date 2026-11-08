import { Moon, Play, Sun, X } from '@phosphor-icons/react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';
import type { Report, ViewId } from '../engine/types';
import { CodeBlock } from './Code';
import { ReportCtx, save, store } from './ctx';
import type { Opened } from './ctx';
import { Film } from './play/Film';
import { Journeys } from './views/Journeys';
import { MapView } from './views/MapView';
import { Overview } from './views/Overview';
import { Parts } from './views/Parts';
import { Readback } from './views/Readback';
import { Risks } from './views/Risks';
import { Stack } from './views/Stack';

export function useTheme(): [string, () => void] {
  const [theme, setTheme] = useState<string>(() => store('readback:theme', ''));
  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  }, [theme]);
  const dark = (theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) === 'dark';
  return [dark ? 'dark' : 'light', () => { const next = dark ? 'light' : 'dark'; setTheme(next); save('readback:theme', next); }];
}

const VIEWS: Array<{ id: ViewId; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'map', label: 'Map' },
  { id: 'journeys', label: 'Journeys' },
  { id: 'parts', label: 'Parts' },
  { id: 'stack', label: 'Stack' },
  { id: 'risks', label: 'Risks' },
  { id: 'readback', label: 'Read it back' },
];

const wantsFilm = (): boolean => location.hash === '#play';

function hashView(): ViewId {
  const h = location.hash.replace('#', '') as ViewId;
  return VIEWS.some((v) => v.id === h) ? h : 'overview';
}

export function Viewer({ report, onHome }: { report: Report; onHome?: () => void }) {
  const [view, setView] = useState<ViewId>(hashView);
  const [focus, setFocus] = useState<string | undefined>();
  const [opened, setOpened] = useState<Opened | null>(null);
  const [film, setFilm] = useState(wantsFilm);
  const [theme, toggle] = useTheme();
  const reduce = useReducedMotion();

  useEffect(() => {
    const on = (): void => {
      setFilm(wantsFilm());
      setView(hashView());
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  useEffect(() => {
    document.title = `${report.project.name} read back`;
  }, [report]);
  useEffect(() => {
    const on = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpened(null);
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  const ctx = useMemo(() => ({
    report, view, focus,
    go: (v: ViewId, id?: string) => {
      setFocus(id);
      location.hash = v;
      setView(v);
      window.scrollTo({ top: 0 });
    },
    show: setOpened,
    play: () => {
      location.hash = 'play';
      setFilm(true);
    },
  }), [report, view, focus]);

  const counts: Partial<Record<ViewId, { n: number; hot?: boolean }>> = {
    journeys: { n: report.journeys.length },
    risks: { n: report.risks.length, hot: report.risks.some((r) => r.severity === 'high') },
    readback: { n: report.questions.length },
  };

  return (
    <ReportCtx.Provider value={ctx}>
      <div className="shell">
        <header className="bar">
          <a className="brand" href="#overview" onClick={(e) => { if (onHome) { e.preventDefault(); onHome(); } }}>
            Readback <span>{report.project.name}</span>
          </a>
          <nav className="tabs" aria-label="Sections">
            {VIEWS.map((v) => {
              const c = counts[v.id];
              return (
                <button key={v.id} className="tab" aria-current={view === v.id ? 'page' : undefined} onClick={() => ctx.go(v.id)}>
                  {v.label}{c ? <small className={c.hot ? 'hot' : ''}>{c.n}</small> : null}
                </button>
              );
            })}
          </nav>
          <button className="play-btn" onClick={ctx.play} aria-label="Play the film of this project"><Play size={15} weight="fill" /><span>Play</span></button>
          <button className="icon-btn" aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} onClick={toggle}>
            {theme === 'dark' ? <Sun size={19} /> : <Moon size={19} />}
          </button>
        </header>
        <main style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          {view === 'overview' && <Overview />}
          {view === 'map' && <MapView />}
          {view === 'journeys' && <Journeys />}
          {view === 'parts' && <Parts />}
          {view === 'stack' && <Stack />}
          {view === 'risks' && <Risks />}
          {view === 'readback' && <Readback />}
        </main>
        {film && (
          <Film
            report={report}
            onClose={() => { setFilm(false); location.hash = view; }}
            onExplore={(v) => { setFilm(false); ctx.go(v); }}
          />
        )}
        <AnimatePresence>
          {opened && (
            <motion.aside
              className="drawer"
              role="dialog"
              aria-label={opened.title}
              initial={reduce ? false : { x: 48, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={reduce ? { opacity: 0 } : { x: 48, opacity: 0 }}
              transition={{ duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
            >
              <div className="drawer-head">
                <div>
                  <h2>{opened.title}</h2>
                  {opened.body && <p style={{ whiteSpace: 'pre-wrap' }}>{opened.body}</p>}
                </div>
                <button className="icon-btn" aria-label="Close" onClick={() => setOpened(null)}><X size={20} /></button>
              </div>
              <div className="drawer-body">
                {opened.evidence.map((e, i) => <CodeBlock key={`${e.file}:${e.line}:${i}`} evidence={e} report={report} />)}
                {!opened.evidence.length && <p className="drawer-note">No single line to show for this one.</p>}
              </div>
            </motion.aside>
          )}
        </AnimatePresence>
      </div>
    </ReportCtx.Provider>
  );
}
