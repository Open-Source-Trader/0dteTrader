import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppContainer, ContainerProvider } from './app/container';
import { RootView } from './RootView';
import './design/tokens.css';
import './design/base.css';
import './design/components/components.css';

const container = new AppContainer();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ContainerProvider value={container}>
      <RootView />
    </ContainerProvider>
  </StrictMode>,
);
