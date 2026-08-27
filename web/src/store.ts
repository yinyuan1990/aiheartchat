import { create } from 'zustand';
import { UserProfile } from './api';

interface AppState {
  user: UserProfile | null;
  setUser: (u: UserProfile | null) => void;
}

export const useApp = create<AppState>((set) => ({
  user: null,
  setUser: (user) => set({ user }),
}));
