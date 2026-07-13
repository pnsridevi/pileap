import { useAuthStore } from '@/store/authStore';

export function useAuth() {
  const { isLoggedIn, isLoading, user, session } = useAuthStore();
  return { isLoggedIn, isLoading, user, session };
}