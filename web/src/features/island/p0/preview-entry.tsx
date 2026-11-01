import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PreviewPage } from './PreviewPage';
import content from './content.json';

document.title = content.title;
createRoot(document.getElementById('root')!).render(<StrictMode><PreviewPage /></StrictMode>);
