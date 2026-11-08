import { ArrowRight, FolderOpen, Moon, Sun } from '@phosphor-icons/react';
import { useRef, useState } from 'react';
import type { Report } from '../engine/types';
import { fromDrop, fromFileList, fromGithub, parseGithub } from './ingest';
import type { Ingested } from './ingest';
import { useTheme, Viewer } from './Viewer';

const REPO = 'https://github.com/MuhammadMurtuzaHussain/readback';

export function Site() {
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [url, setUrl] = useState('');
  const [over, setOver] = useState(false);
  const [theme, toggle] = useTheme();
  const folder = useRef<HTMLInputElement>(null);

  const run = (data: Ingested): void => {
    setBusy(`Reading ${data.files.length} files on this computer`);
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e) => {
      w.terminate();
      setBusy(null);
      if (e.data.ok) setReport(e.data.report);
      else setError(`Something went wrong while reading the project: ${e.data.error}`);
    };
    w.onerror = () => {
      w.terminate();
      setBusy(null);
      setError('The analysis stopped unexpectedly. Try the command line version.');
    };
    w.postMessage(data);
  };

  const guard = (fn: () => Promise<Ingested>): void => {
    setError('');
    setBusy('Opening your project');
    fn().then(run).catch((e) => {
      setBusy(null);
      setError(e instanceof Error ? e.message : 'That did not work.');
    });
  };

  const github = (e?: React.FormEvent): void => {
    e?.preventDefault();
    const target = parseGithub(url);
    if (!target) {
      setError('That does not look like a GitHub repository address.');
      return;
    }
    guard(() => fromGithub(target.owner, target.repo, (s) => setBusy(s)));
  };

  const sample = async (): Promise<void> => {
    setBusy('Opening the sample');
    try {
      const res = await fetch('./demo/lunchbox.json');
      setReport(await res.json());
      setBusy(null);
    } catch {
      setBusy(null);
      setError('The sample did not load.');
    }
  };

  if (report) return <Viewer report={report} onHome={() => { setReport(null); location.hash = ''; }} />;
  if (busy) {
    return (
      <div className="busy" role="status">
        <b>{busy}</b>
        <span>Nothing is being uploaded. This tab is doing the reading.</span>
      </div>
    );
  }

  return (
    <div
      className={`land drop ${over ? 'over' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); guard(() => fromDrop(e.dataTransfer.items)); }}
    >
      <header className="land-nav">
        <a className="brand" href="./">Readback</a>
        <nav>
          <a href="#how">How it stays honest</a>
          <a href="#run">Run it yourself</a>
          <a href={REPO}>GitHub</a>
        </nav>
        <button className="icon-btn" aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} onClick={toggle}>
          {theme === 'dark' ? <Sun size={19} /> : <Moon size={19} />}
        </button>
      </header>

      <section className="hero">
        <div>
          <h1>You shipped it. Can you explain it?</h1>
          <p>Readback reads your code, shows what it really does, then tests whether you can say it back.</p>
          <form className="input" onSubmit={github}>
            <label htmlFor="repo">A public GitHub repository</label>
            <div className="urlrow">
              <input id="repo" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="github.com/you/your-app" spellCheck={false} autoComplete="off" />
              <button className="btn primary" type="submit">Read it <ArrowRight size={18} /></button>
            </div>
            <div className="alt">
              <button type="button" onClick={() => folder.current?.click()}><FolderOpen size={17} style={{ verticalAlign: '-3px' }} /> Choose a folder</button>
              <button type="button" onClick={sample}>See a sample app</button>
            </div>
            <input
              ref={folder} type="file" hidden
              {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
              onChange={(e) => e.target.files?.length && guard(() => fromFileList(e.target.files!))}
            />
            {error && <p className="err" role="alert">{error}</p>}
          </form>
        </div>
        <picture>
          <source srcSet="./shots/hero-dark.png" media="(prefers-color-scheme: dark)" />
          <img src="./shots/hero-light.png" alt="Readback's map of a sample app with Supabase switched off: every screen and route that depends on it is highlighted." width="1464" height="686" />
        </picture>
      </section>

      <section className="lsec feature flip">
        <div>
          <h3>Press play and watch your own app explained</h3>
          <p>A 90 second film of your project, built from the same facts: what it is, what it stands on, one click followed to the database, and what could bite you. It can read itself aloud with a voice that runs on your own computer.</p>
        </div>
        <picture>
          <source srcSet="./shots/film-journey-dark.png" media="(prefers-color-scheme: dark)" />
          <img className="shot" src="./shots/film-journey-light.png" alt="The film playing one step of a journey: a path moving from the browser lane to the server lane, beside the code that runs." loading="lazy" width="1440" height="900" />
        </picture>
      </section>

      <section className="lsec feature">
        <div>
          <h3>Follow one click from the button to the database</h3>
          <p>Journeys are traced from your code and named with your own button text. Step through them next to the real lines that run.</p>
        </div>
        <img className="shot" src="./shots/journeys-light.png" alt="A journey stepping from a button click through the browser and server to the database, with the code for the current step beside it." loading="lazy" width="1440" height="900" />
      </section>

      <section className="lsec feature flip" style={{ borderTop: 0 }}>
        <div>
          <h3>Turn a service off and watch what breaks</h3>
          <p>Click Supabase or OpenAI on the map. The screens and routes that depend on it light up, so you know what your app is really standing on.</p>
        </div>
        <img className="shot" src="./shots/outage-light.png" alt="The map with Supabase switched off and every dependent screen and route highlighted." loading="lazy" width="1440" height="900" />
      </section>

      <section className="lsec feature">
        <div>
          <h3>Then it tests you, with questions only your app could produce</h3>
          <p>Which file handles this click? Which route can a stranger call? Wrong answers are real names from your repo, so you cannot guess your way through.</p>
        </div>
        <img className="shot" src="./shots/readback-light.png" alt="A multiple choice question about the sample app, with real file paths as the options." loading="lazy" width="1440" height="900" />
      </section>

      <section className="lsec" id="how">
        <h2>It shows its working</h2>
        <p>Every claim links to the line it came from. Anything inferred is marked as inferred. What it cannot follow, it lists instead of guessing. No model is needed, and this page reads your project inside your own browser.</p>
        <div className="vs-wrap"><table className="vs">
          <thead><tr><th scope="col">Tool</th><th scope="col">How it knows</th><th scope="col">Written for</th><th scope="col">Where your code goes</th></tr></thead>
          <tbody>
            <tr className="us"><th scope="row">Readback</th><td>Parses your code and traces calls, no model needed</td><td>The person who shipped it</td><td>Nowhere</td></tr>
            <tr><th scope="row">GitDiagram</th><td>A model reads the file tree and README</td><td>Developers exploring a repo</td><td>To a model provider</td></tr>
            <tr><th scope="row">DeepWiki</th><td>A model writes a wiki</td><td>Developers exploring a repo</td><td>Public repos, hosted</td></tr>
            <tr><th scope="row">Understand-Anything</th><td>Static analysis plus a team of model agents</td><td>Developers using a coding agent</td><td>To your model provider</td></tr>
            <tr><th scope="row">Archify</th><td>Your coding agent writes the diagram, Archify validates its shape</td><td>Developers documenting systems</td><td>To your model provider</td></tr>
            <tr><th scope="row">Repomix</th><td>Packs your repo into one file for a model</td><td>Giving context to a model</td><td>Wherever you paste it</td></tr>
          </tbody>
        </table></div>
      </section>

      <section className="lsec" id="run">
        <h2>Run it on your own machine</h2>
        <p>For private code. One command, no account, no key.</p>
        <div className="run">
          <div className="term">npx https://github.com/MuhammadMurtuzaHussain/readback/releases/latest/download/readback.tgz ./my-app</div>
        </div>
      </section>

      <footer className="foot">
        <span>Open source under the MIT licence.</span>
        <a href={REPO}>Read the code</a>
      </footer>
    </div>
  );
}
