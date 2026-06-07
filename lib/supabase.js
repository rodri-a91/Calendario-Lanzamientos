import { createClient } from '@supabase/supabase-js';

// Cliente de Supabase para el backend.
// Usa la service_role key, que IGNORA el RLS: por eso solo puede
// vivir aquí, en el servidor, y NUNCA debe llegar al navegador.
// persistSession: false porque en serverless no hay sesión que mantener.
export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);
