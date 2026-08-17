# CoreAssets

Índice web de assets 3D para desarrollo de juegos (mallas, animaciones, GUIs y más), con un panel de administración privado para publicar y gestionar el contenido.

## ¿Qué es esto?

CoreAssets es una galería pública donde se listan assets descargables organizados por categoría (BODY, GAMES, ASSETS, ANIMATIONS, etc.), cada uno con imágenes, descripción, formato de archivo y link de descarga. El contenido se revisa y publica manualmente desde un panel de administración antes de aparecer en el sitio.

## Características

- **Galería pública** con filtros por categoría, buscador y sistema de favoritos (guardados en el navegador).
- **Vista de detalle en modal**, sin recargar la página, con slider de imágenes.
- **Panel de administración** protegido por contraseña, con:
  - Editor para crear, editar y eliminar assets.
  - Publicación directa al repositorio vía GitHub API (los cambios se ven reflejados en el sitio en ~1 minuto).
  - Sistema de usuarios registrados por dispositivo: el primer acceso pide elegir un nombre de usuario único, vinculado a ese navegador.
  - Gestión de acceso: solo el usuario `Vyn` puede revocar el acceso de otros usuarios registrados.

## Tecnologías

- HTML, CSS y JavaScript sin frameworks (vanilla).
- [Tailwind CSS](https://tailwindcss.com/) vía CDN para los estilos del panel admin.
- [Cloudflare Workers](https://workers.cloudflare.com/) como backend: autenticación y publicación de cambios contra la API de GitHub.

## Estructura del repositorio

```
index.html        → Página pública (galería)
admin.html         → Panel de administración
script.js          → Lógica compartida (galería, admin, login, usuarios)
style.css          → Estilos de la vista pública
Vyn-assets.js       → Datos de los assets publicados
Vyn-users.js        → Usuarios registrados con acceso al panel admin
```

## Créditos y uso de los assets

Todos los assets publicados en este sitio pertenecen a sus respectivos creadores originales. Este repositorio y sitio no reclaman autoría ni propiedad sobre ningún archivo listado; funcionan únicamente como un índice de referencia.

Si eres el autor de un asset publicado aquí y quieres que se te acredite o que se retire el listado, contacta a **nobodxy85@gmail.com**.

## Aviso

Los assets listados en este sitio están pensados para usarse en juegos compatibles con la plataforma Roblox. Este proyecto es independiente y no tiene afiliación, patrocinio ni respaldo de Roblox Corporation. El nombre se menciona únicamente con fines descriptivos.****
