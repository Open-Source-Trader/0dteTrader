import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppContainer, ContainerProvider } from './app/container';
import { RootView } from './RootView';
import './design/tokens.css';
import './design/base.css';
import './design/components/components.css';

// Scale the fixed 430x932 phone frame to fit the window (up or down).
function updateScale() {
  const scale = Math.min(window.innerWidth / 430, window.innerHeight / 932);
  document.documentElement.style.setProperty('--app-scale', String(scale));
}
updateScale();
window.addEventListener('resize', updateScale);

const container = new AppContainer();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ContainerProvider value={container}>
      <RootView />
    </ContainerProvider>
  </StrictMode>,
);
