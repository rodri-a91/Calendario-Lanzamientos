# Calendario de lanzamientos

Calendario mensual de lanzamientos de videojuegos (PC, PlayStation, Xbox y
Switch) con datos de [IGDB](https://www.igdb.com/). Permite marcar cada juego
como *me interesa*, *reservado*, *comprado* o *no me interesa*. Los juegos más
esperados (hype de IGDB) se destacan.

Se instala como app (PWA) y se despliega en Vercel, con Supabase como base de
datos y autenticación.

## Cómo funciona

```
navegador ──► /api/calendar?month=YYYY-MM ──► Supabase (caché) ──► IGDB
    │                (Vercel)
    └──► Supabase (tracked_games, con RLS)
```

- **`/api/calendar`** devuelve el calendario de un mes agrupado por juego.
  Sigue un *cache-aside*: si el mes se descargó hace menos de 12 h lo lee de
  Supabase; si no, lo pide a IGDB, lo guarda y borra las fechas que IGDB ya no
  devuelve. Si IGDB falla, sirve la caché aunque esté caducada.
- **El navegador** filtra (descartados, "solo míos") y
  guarda tus estados directamente en Supabase con la *anon key*; el RLS hace
  que cada usuario solo vea y toque sus filas.
- **Fecha principal**: un juego aparece una vez por mes, en la fecha que sale
  en más plataformas (la más tardía si empatan). Las fechas exclusivas de Asia
  solo se usan si el juego no tiene otra.

## Estructura

| Archivo | Qué hace |
| --- | --- |
| `index.html`, `styles.css`, `app.js` | Interfaz (sin build ni framework) |
| `releases.js` | Elección de la fecha principal (funciones puras) |
| `config.js` | URL y *anon key* públicas de Supabase |
| `api/calendar.js` | Endpoint de Vercel |
| `lib/igdb.js` | Descarga de IGDB y caché en Supabase |
| `lib/transform.js` | Transformaciones de datos (funciones puras) |
| `lib/igdbToken.js` | Token de Twitch, guardado en Supabase |
| `lib/supabase.js` | Cliente de Supabase con la *service_role key* |
| `schema.sql` | Tablas y políticas RLS |
| `test/` | Tests (no se despliegan, ver `.vercelignore`) |

## Puesta en marcha

1. **Supabase**: crea un proyecto y ejecuta `schema.sql` en el SQL Editor.
   Crea tu usuario en *Authentication → Users*: la app solo tiene inicio de sesión, no registro.
2. **Twitch/IGDB**: registra una aplicación en
   <https://dev.twitch.tv/console/apps> (tipo *Confidential*) para obtener el
   *Client ID* y el *Client Secret*.
3. **`config.js`**: pon la URL y la *anon key* de Supabase. Son públicas;
   **nunca** pongas aquí la *service_role key*.
4. **Vercel**: importa el repositorio y define estas variables de entorno:

   | Variable | Origen |
   | --- | --- |
   | `SUPABASE_URL` | Supabase → Project Settings → API |
   | `SUPABASE_SERVICE_ROLE_KEY` | Ídem (secreta: ignora el RLS) |
   | `TWITCH_CLIENT_ID` | Consola de Twitch |
   | `TWITCH_CLIENT_SECRET` | Consola de Twitch (secreta) |

Requiere Node 22 o superior.

## Tests

```sh
npm test
```

Usan el *test runner* de Node (`node:test`), sin dependencias. Cubren las
funciones puras de `lib/transform.js` y `releases.js`; no tocan la red ni
Supabase.

## Datos de IGDB a tener en cuenta

- Solo se descargan juegos con al menos 1 de hype, para dejar fuera los que
  nadie espera. Los de 30 o más se destacan con 🔥.
- La precisión de la fecha se deduce del texto de IGDB: `"Oct 20, 2026"` es
  exacta; `"Q4 2026"`, `"2026"` o `"TBD"` son aproximadas.
- La región sale de `release_region` (1 Europa, 2 Norteamérica, 5 Japón,
  8 mundial…). El antiguo campo `region` está obsoleto y ya no viene relleno.
