import crypto from 'node:crypto';
import type { RequestHandler } from 'express';

/** Basic authentication for the single-owner panel. Terminate HTTPS at the proxy. */
export const panelAuth: RequestHandler = (req, res, next) => {
  const username = process.env.PANEL_USERNAME;
  const password = process.env.PANEL_PASSWORD;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (!username || !password || password.length < 16) {
    res.status(503).json({ success: false, error: 'Configure PANEL_USERNAME and PANEL_PASSWORD (at least 16 characters).' });
    return;
  }
  const header = req.get('authorization') || '';
  const supplied = header.startsWith('Basic ') && header.length < 4096
    ? Buffer.from(header.slice(6), 'base64').toString('utf8') : '';
  const digest = (value: string) => crypto.createHash('sha256').update(value).digest();
  if (!crypto.timingSafeEqual(digest(supplied), digest(`${username}:${password}`))) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Telegram management", charset="UTF-8"');
    res.status(401).json({ success: false, error: 'Authentication required' });
    return;
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.get('origin');
    let foreignOrigin = false;
    if (origin) {
      try {
        const requestOrigin = new URL(origin);
        foreignOrigin = process.env.PANEL_ORIGIN
          ? requestOrigin.origin !== new URL(process.env.PANEL_ORIGIN).origin
          : requestOrigin.host !== req.get('host');
      } catch { foreignOrigin = true; }
    }
    if (foreignOrigin || req.get('sec-fetch-site') === 'cross-site') {
      res.status(403).json({ success: false, error: 'Cross-site request rejected' });
      return;
    }
  }
  next();
};
