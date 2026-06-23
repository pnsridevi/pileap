import { create } from 'zustand';
import { Session } from '@supabase/supabase-js';

interface User {
  id:    string;
  email: string | null;
  phone: string | null;
}

interface AuthState {
  isLoggedIn: boolean;
  isLoading:  boolean;
  user:       User | null;
  session:    Session | null;
  setSession: (session: Session | null) => void;
  signOut:    () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  isLoggedIn: false,
  isLoading:  true,
  user:       null,
  session:    null,

  setSession: (session) => set({
    session,
    isLoggedIn: !!session,
    isLoading:  false,
    user: session?.user ? {
      id:    session.user.id,
      email: session.user.email ?? null,
      phone: session.user.phone ?? null,
    } : null,
  }),

  signOut: () => set({
    isLoggedIn: false,
    user:       null,
    session:    null,
    isLoading:  false,
  }),
}));