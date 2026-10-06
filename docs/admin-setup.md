# Administración desde la interfaz

Esta edición está pensada para un único administrador y una instancia de Node.js con almacenamiento persistente. OpenRouter, Higgsfield y productos de API.market se configuran desde **APIs**. Los proveedores originales y Cloudinary conservan por ahora su configuración por variables de entorno.

## Primer inicio local

1. Ejecuta `npm install` y `npm run dev`.
2. Abre `http://localhost:3000`. En la terminal aparece un código de instalación temporal. Es el único secreto mostrado intencionadamente en los registros y solo sirve durante 30 minutos, antes de crear el administrador.
3. Introduce el código en **Crear administrador**, elige una contraseña de al menos 15 caracteres y confírmala.
4. Guarda el código de recuperación en tu gestor de contraseñas. No se vuelve a mostrar. Cada uso o cambio de contraseña lo reemplaza.
5. Añade una conexión, compruébala y guárdala. Guardar sin comprobar es posible: no implica que la clave sea válida ni que tenga saldo.

Con `npm run dev` no hace falta definir una URL pública si abres el panel desde `localhost`, `127.0.0.1` o `[::1]`. El origen debe coincidir exactamente con el protocolo, host y puerto de acceso; no se usan cabeceras de proxy para autorizarlo. No alternes entre esas direcciones durante la configuración. Una URL explícita en `OPEN_HIGGSFIELD_APP_ORIGIN` tiene prioridad; en producción sigue siendo obligatoria.

Si caduca o pierdes el código de instalación, ejecuta `npm run setup:token` en tu terminal local o reinicia el servicio para generar otro. El comando requiere las dependencias de desarrollo; en el contenedor de producción se usa el reinicio. Crear el administrador invalida todos los códigos de instalación; no hay registro público posterior. `OPEN_HIGGSFIELD_SETUP_TOKEN` permite suministrar un código inicial de al menos 24 caracteres desde el gestor de secretos del despliegue. El plazo se renueva al reiniciar antes de completar la instalación.

## EasyPanel

- Construye con el Dockerfile del repositorio, puerto interno 3000, una réplica.
- Monta un volumen persistente en `/app/data`, escribible por el usuario UID 1001 del contenedor.
- Define `OPEN_HIGGSFIELD_APP_ORIGIN=https://tu-dominio.example`, sin barra final. Es obligatorio en producción para comprobar el origen de operaciones de escritura; no contiene credenciales.
- Activa HTTPS en el dominio y usa el proxy de EasyPanel. Las cookies de producción requieren HTTPS. No publiques directamente el puerto interno de Node.
- Configura en el proxy límites de petición (32 MiB), tiempos de espera y límites de conexiones. Las rutas de la aplicación también limitan tamaños e intentos.
- Abre el dominio, consulta el código inicial en los registros privados del servicio y crea el administrador. No pongas API keys en el Dockerfile, argumentos de build ni variables `NEXT_PUBLIC_*`.

Los reinicios y redespliegues conservan el administrador y sus conexiones si conservas el volumen. La implementación no admite Vercel con disco efímero ni múltiples réplicas sin un almacenamiento/autenticación compartidos adecuados.

## Persistencia, recuperación y copias

En el directorio de datos se encuentran `.higgsfield-security/admin.json` (hash scrypt, sesiones opacas hasheadas, límites y auditoría), `.higgsfield-security/master-key.json` (clave aleatoria de cifrado), y `provider-connections.enc.json` (AES-256-GCM). Los archivos privados usan permisos 0600 y el directorio privado 0700. Están excluidos de Git y del contexto Docker.

La contraseña no cifra la bóveda: cambiarla o recuperar el acceso no rompe las conexiones. Al cambiarla se revocan todas las sesiones anteriores. **Cerrar todas las sesiones** también permite revocarlas desde la interfaz.

Haz copias externas cifradas del volumen completo con el servicio detenido. Conserva la clave maestra y la bóveda juntas en la copia protegida: perder la clave hace irrecuperables las credenciales. El cifrado no protege frente a alguien que controle el servidor o robe simultáneamente bóveda y clave. Para mayor aislamiento, usa cifrado del disco/volumen y restringe acceso a EasyPanel y a sus copias. No hay exportación web del secreto maestro.

Si olvidaste tu contraseña usa **He olvidado mi contraseña** y tu código de recuperación. Si también perdiste ese código, necesitas restaurar una copia de seguridad o intervención del operador; no existe una puerta trasera ni restablecimiento público sin prueba de propiedad.

Las escrituras utilizan bloqueos entre procesos y reemplazo atómico. Un cierre abrupto mientras se escribe puede dejar un directorio `.lock`: detén el servicio, verifica que no quedan procesos usando el volumen y retira únicamente el bloqueo identificado dentro de `.higgsfield-security`. Nunca borres la carpeta ni los archivos de claves para resolverlo. La aplicación falla cerrada ante un bloqueo o datos corruptos.

## Migración de conexiones anteriores

El nuevo acceso se crea desde la interfaz aunque exista `OPEN_HIGGSFIELD_ADMIN_PASSWORD`. Las conexiones v1 siguen siendo legibles con su clave antigua (`OPEN_HIGGSFIELD_CREDENTIALS_KEY` o, si no existía, la contraseña de administrador antigua). Mantén esos valores hasta volver a guardar una conexión: la bóveda completa se reescribe entonces en v2 con la clave maestra independiente. Verifica el funcionamiento y conserva una copia antes de retirar las variables antiguas. Un error de descifrado no sobrescribe los datos.

## Garantías y límites

- Sesiones de 8 horas, cookies HttpOnly/SameSite Strict/Secure en producción, comprobación de origen, autenticación en proxy y rutas privadas, respuestas privadas sin caché.
- Límites persistentes globales de administrador: 8 intentos de autenticación/minuto, 20 operaciones de conexiones/minuto y 10 generaciones/minuto. No se confía en IPs aportadas por cabeceras arbitrarias.
- La contraseña usa scrypt con sal aleatoria, N=131072/r=8/p=1. Las claves maestras, de proveedor y de recuperación son independientes. No se registran API keys, contraseñas ni sesiones.
- Las credenciales solo se envían a los hosts oficiales permitidos. Las peticiones autenticadas no siguen redirecciones; una URL de estado fuera del proveedor se rechaza. Las descargas de resultados no llevan claves y validan cada destino y su dirección IP.
- Las solicitudes de generación aceptan `Idempotency-Key`. La interfaz añade uno por envío. Un reenvío con el mismo identificador conserva su resultado durante 24 horas; una operación incierta queda bloqueada para evitar cobros duplicados. No se reintentan automáticamente peticiones de generación. No es una garantía de facturación del proveedor.
- OpenRouter descubre su catálogo de imágenes/video; Higgsfield usa los modelos integrados en el adaptador. API.market descubre herramientas por producto: los productos con esquemas especiales pueden necesitar adaptación. Una clave válida no garantiza acceso a todos los modelos ni a todas las funciones.
- Las referencias subidas que requieren URL pública usan Cloudinary, configurado por entorno. La integración de Cloudinary en el panel no forma parte de este cambio.
- La rotación automatizada de la clave maestra no está implementada; sí se pueden sustituir las API keys y cambiar la contraseña desde el panel.

## Validación

`npm run check` ejecuta lint, TypeScript, pruebas de autenticación/cifrado/SSRF/CSRF y build de producción. `npm audit --omit=dev` comprueba dependencias del runtime. Las generaciones reales requieren credenciales y saldo; no se consideran verificadas por estas pruebas.

Verificación del 6 de octubre de 2026: runtime sin avisos de `npm audit`. Permanecen cinco avisos de severidad alta en la cadena de desarrollo `eslint-config-next → fast-glob → micromatch → braces`; la corrección automática propone bajar a Next ESLint 14, incompatible con esta aplicación Next 16, por lo que no se aplica. Estas dependencias son de lint y no forman parte de la aplicación de producción standalone.
