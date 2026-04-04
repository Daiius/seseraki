import { Hono } from 'hono';

export const app = new Hono();

const route = app.get('/', (c) => {
  return c.json({ message: 'Hello Shogi!' });
});

export type AppType = typeof route;
