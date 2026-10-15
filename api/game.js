import { getGameDetails } from '../lib/igdb.js';

// Endpoint: GET /api/game?id=123
// Devuelve la ficha de un juego (resumen, géneros, compañías, capturas…).
// Solo para juegos que ya están en la caché del calendario.
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const raw = typeof req.query.id === 'string' ? req.query.id : '';
  const id = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Parámetro "id" inválido (usa un entero positivo).' });
  }

  try {
    const details = await getGameDetails(id);
    if (!details) {
      return res.status(404).json({ error: 'Juego no encontrado.' });
    }
    // Datos públicos y que cambian poco: el CDN los guarda un día.
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
    return res.status(200).json(details);
  } catch (err) {
    console.error('Error en /api/game:', err);
    return res.status(502).json({ error: 'No se pudo obtener la ficha del juego.' });
  }
}
