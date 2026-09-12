import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';

/**
 * Compara o SHA-256 dos dois lados: `timingSafeEqual` estoura com buffers de
 * tamanhos diferentes, e o tamanho do token já seria um vazamento. Hash tem
 * sempre 32 bytes.
 */
function matches(presented: string, expectedHash: Buffer): boolean {
  return timingSafeEqual(createHash('sha256').update(presented).digest(), expectedHash);
}

export function bearerAuth(expectedHash: Buffer): RequestHandler {
  return (req, res, next) => {
    const [scheme, token] = (req.get('authorization') ?? '').split(' ');

    if (scheme?.toLowerCase() !== 'bearer' || !token || !matches(token, expectedHash)) {
      // 401 genérico: não distingue "faltou header" de "token errado", e sem
      // WWW-Authenticate para não anunciar o esquema a quem varre a rede.
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    next();
  };
}
