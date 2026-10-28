import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { IslandApp } from './IslandApp';
import content from './content/zh-CN.json';
import './styles/island.css';

document.title = content.appName;
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <IslandApp />
  </StrictMode>,
);
