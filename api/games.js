import { getGamesByIds } from '../lib/igdb.js';

const MAX_IDS = 500;

// Endpoint: GET /api/games?ids=1,2,3
// Devuelve esos juegos con todas sus fechas en caché (para "Mi lista").
// Solo lee la caché: nunca dispara descargas a IGDB.
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const raw = typeof req.query.ids === 'string' ? req.query.ids : '';
  if (!/^\d+(,\d+)*$/.test(raw)) {
    return res.status(400).json({ error: 'Parámetro "ids" inválido (usa 1,2,3).' });
  }
  const ids = [...new Set(raw.split(',').map(Number))];
  if (ids.length > MAX_IDS || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    return res.status(400).json({ error: `Se admiten hasta ${MAX_IDS} ids enteros positivos.` });
  }

  try {
    const games = await getGamesByIds(ids);
    // La lista de ids es personal: que no la guarde ningún CDN.
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).json({ games });
  } catch (err) {
    console.error('Error en /api/games:', err);
    return res.status(502).json({ error: 'No se pudieron obtener los juegos.' });
  }
}
