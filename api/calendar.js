import { getCalendar } from '../lib/igdb.js';

// Endpoint: GET /api/calendar?month=YYYY-MM
// Devuelve el calendario general del mes (agrupado por juego).
// Todo lo personal (tus estados, el deslizador de hype, los descartados)
// lo resuelve el navegador; esta función es "tonta" y cacheable.
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const { month } = req.query;

  // Validación estricta del parámetro (YYYY-MM, mes 01-12).
  if (!month || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return res.status(400).json({ error: 'Parámetro "month" inválido (usa YYYY-MM).' });
  }

  try {
    const data = await getCalendar(month);

    // Cacheo suave en el CDN de Vercel: sirve la versión cacheada 1 h,
    // y mientras revalida en segundo plano hasta 24 h.
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');

    return res.status(200).json(data);
  } catch (err) {
    console.error('Error en /api/calendar:', err);
    return res.status(502).json({ error: 'No se pudo obtener el calendario.' });
  }
}
