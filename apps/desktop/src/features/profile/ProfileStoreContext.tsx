import type { ReactNode } from 'react';
import type { ProfileStore } from './ProfileStore';
import { ProfileStoreContext } from './useProfileStore';

export function ProfileStoreProvider({
  store,
  children,
}: {
  store: ProfileStore;
  children: ReactNode;
}) {
  return <ProfileStoreContext.Provider value={store}>{children}</ProfileStoreContext.Provider>;
}
