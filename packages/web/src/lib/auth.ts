import { client } from './honoClient';

let sessionPromise: Promise<boolean> | null = null;

export function checkSession(): Promise<boolean> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      try {
        const res = await client.auth.me.$get();
        return res.ok;
      } catch {
        return false;
      }
    })();
  }
  return sessionPromise;
}

export async function login(username: string, password: string): Promise<boolean> {
  const res = await client.auth.login.$post({ json: { username, password } });
  sessionPromise = res.ok ? Promise.resolve(true) : null;
  return res.ok;
}

export async function logout(): Promise<void> {
  await client.auth.logout.$post();
  sessionPromise = Promise.resolve(false);
}
