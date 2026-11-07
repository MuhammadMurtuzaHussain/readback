import '@fontsource-variable/atkinson-hyperlegible-next/index.css';
import '@fontsource-variable/atkinson-hyperlegible-mono/index.css';
import './styles.css';
import { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import type { Report } from '../engine/types';
import { Viewer } from './Viewer';

declare const __HAS_ENGINE__: boolean;

function embedded(): Report | null {
  const el = document.getElementById('readback-report');
  const text = el?.textContent?.trim();
  if (!text || text.startsWith('__READBACK')) return null;
  try {
    return JSON.parse(text) as Report;
  } catch {
    return null;
  }
}

const Site = __HAS_ENGINE__ ? lazy(() => import('./Site').then((m) => ({ default: m.Site }))) : null;

const report = embedded();
const root = createRoot(document.getElementById('root')!);
if (report) root.render(<Viewer report={report} />);
else if (Site) root.render(<Suspense fallback={null}><Site /></Suspense>);
else root.render(<p style={{ padding: 32 }}>This page has no report in it. Run readback on a project to make one.</p>);
