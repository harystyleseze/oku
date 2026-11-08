import type { Request, Response, NextFunction } from "express";
import { eq } from "drizzle-orm";
import { db } from "./db.js";
import { sessions, type User } from "./schema.js";
import { config } from "./config.js";

export const SESSION_COOKIE = "oku_session";
const SESSION_DAYS = 30;

export async function createSession(res: Response, userId: string) {
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 3600 * 1000);
  const [session] = await db.insert(sessions).values({ userId, expiresAt }).returning({ id: sessions.id });
  res.cookie(SESSION_COOKIE, session.id, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.cookieSecure,
    expires: expiresAt,
    path: "/",
  });
}

export async function destroySession(req: Request, res: Response) {
  const id = req.cookies?.[SESSION_COOKIE];
  if (id) await db.delete(sessions).where(eq(sessions.id, id));
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

export async function userFromSessionId(sessionId: string | undefined): Promise<User | null> {
  if (!sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId)) return null;
  const session = await db.query.sessions.findFirst({ where: eq(sessions.id, sessionId), with: { user: true } });
  if (!session || session.expiresAt < new Date()) return null;
  return session.user;
}

declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

/** Attaches req.user when a valid session cookie is present. Never rejects. */
export async function attachUser(req: Request, _res: Response, next: NextFunction) {
  try {
    const user = await userFromSessionId(req.cookies?.[SESSION_COOKIE]);
    if (user) req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

export function requireUser(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    res.status(401).json({ error: "Sign in to continue." });
    return;
  }
  next();
}
