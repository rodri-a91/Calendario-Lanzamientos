import { supabase } from './supabase.js';

const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';

// Colchón de seguridad: renovamos si al token le queda menos de 1 día,
// para no arriesgarnos a que caduque a mitad de una petición.
const REFRESH_BUFFER_MS = 24 * 60 * 60 * 1000;

// Devuelve un token de IGDB válido, reutilizando el cacheado en Supabase
// y pidiendo uno nuevo a Twitch solo cuando falta o está a punto de caducar.
export async function getIgdbToken() {
  // 1. ¿Tenemos uno guardado y con margen suficiente?
  const { data: row } = await supabase
    .from('igdb_token')
    .select('access_token, expires_at')
    .eq('id', 1)
    .maybeSingle();

  if (row && new Date(row.expires_at).getTime() - Date.now() > REFRESH_BUFFER_MS) {
    return row.access_token;
  }

  // 2. Si no, lo pedimos a Twitch (flujo client_credentials).
  const params = new URLSearchParams({
    client_id: process.env.TWITCH_CLIENT_ID,
    client_secret: process.env.TWITCH_CLIENT_SECRET,
    grant_type: 'client_credentials',
  });

  const res = await fetch(`${TWITCH_TOKEN_URL}?${params}`, { method: 'POST' });
  if (!res.ok) {
    throw new Error(`Error al pedir token a Twitch: ${res.status}`);
  }

  const { access_token, expires_in } = await res.json();
  const expires_at = new Date(Date.now() + expires_in * 1000).toISOString();

  // 3. Lo guardamos en la fila única (id = 1).
  await supabase
    .from('igdb_token')
    .upsert({ id: 1, access_token, expires_at }, { onConflict: 'id' });

  return access_token;
}
