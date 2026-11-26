import type { NextFunction, Request, Response } from 'express';
import { query } from '../db/pool.js';
import type { SessionUser } from '../types/index.js';

declare global {
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const emailHeader = req.header('x-user-email');
  const email = (emailHeader || 'admin@company.local').trim().toLowerCase();

  const users = await query<SessionUser>(
    `select id, name, email, role, status
     from users
     where lower(email) = $1
     limit 1`,
    [email],
  );

  const user = users[0];
  if (!user || user.status !== 'active') {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  req.user = user;
  next();
}
