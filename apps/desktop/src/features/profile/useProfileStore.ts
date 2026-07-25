import { createContext, useContext } from 'react';
import type { ProfileStore } from './ProfileStore';

export const ProfileStoreContext = createContext<ProfileStore | null>(null);

export function useProfileStore(): ProfileStore {
  const store = useContext(ProfileStoreContext);
  if (!store) throw new Error('ProfileStore not provided');
  return store;
}
