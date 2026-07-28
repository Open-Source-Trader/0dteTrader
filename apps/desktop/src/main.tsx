import { StrictMode, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { AppContainer, ContainerProvider } from './app/container';
import { ServerConfigStore } from './core/api/ServerConfigStore';
import { useStore } from './core/observable';
import { RootView } from './RootView';
import './design/fonts.css';
import './design/tokens.css';
import './design/base.css';
import './design/components/components.css';
import './design/hud.css';

const serverConfigStore = new ServerConfigStore();

/** Rebuilds the container when the server base URL changes, so saving a new
    server on the login screen takes effect without an app restart. */
// eslint-disable-next-line react-refresh/only-export-components -- entry file, never hot-refreshed
function App() {
  const { baseUrl } = useStore(serverConfigStore);
  const container = useMemo(() => new AppContainer(serverConfigStore, baseUrl), [baseUrl]);
  return (
    <ContainerProvider value={container}>
      <RootView />
    </ContainerProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
