# Workflows: primera versión

## Uso

1. En Studio, pulsa **Workflows** (arriba a la izquierda).
2. Pulsa **Nuevo workflow** para abrir un borrador con un bloque de prompt, o **Ver plantillas** para elegir un proceso predefinido. La plantilla **Prueba sin créditos** permite guardar, ejecutar y aprobar sin llamar a proveedores.
3. Para generar, elige una plantilla de imagen o video. Selecciona cada bloque y elige su modelo/conexión.
4. Conecta el punto de salida de un bloque con la entrada correspondiente del siguiente. Texto, imagen de referencia y fotogramas no son intercambiables.
5. Guarda. Ejecutar abre una confirmación con el número de generaciones; no conocemos un coste exacto fiable.
6. Abre una ejecución del historial para recuperar progreso, resultados y aprobaciones. Se guarda una copia inmutable del grafo y sus capacidades. Editar el workflow no cambia una ejecución iniciada.

Los cambios del editor se guardan con **Guardar**, no automáticamente. El navegador advierte al salir con cambios pendientes. **Ejecutar hasta este bloque** incluye sus dependencias y vuelve a generarlas: no es un caché ni un reintento gratuito.

## Cobertura real y límites

- OpenRouter: imagen y video según el catálogo de la conexión, parámetros enumerados y referencias por ranura. Imágenes locales se transmiten directamente como data URL, sin publicar los archivos.
- Higgsfield: los endpoints configurados en el catálogo existente. Los endpoints `text-to-video` NO aceptan conexiones de imagen en esta versión; se rechazan antes de gastar. El catálogo no equivale a todos los modelos del sitio web.
- API.market y proveedores legacy siguen funcionando en Studio, pero no se habilitan en workflows hasta tener contratos verificados por producto/adaptador. Magnific, audio, lotes, colaboración, importación y subflujos quedan fuera de esta primera versión.
- Una imagen por ranura; si el proveedor devuelve varias, el siguiente bloque recibe la primera. Todas pueden descargarse desde el inspector.
- 30 bloques / 60 conexiones / 6 generaciones por ejecución. Una llamada del motor a la vez, 3 ejecuciones activas globales y 1 activa por workflow. Hasta 200 workflows y 800 ejecuciones; no se borra historial automáticamente.
- Los archivos/resultados de workflows se consultan aquí; el historial del Studio anterior se conserva separado.
- No hay reintento automático de una generación. `Revisar solicitud` significa que puede haber sido aceptada/cobrada. Si se guardó un identificador remoto, se puede volver a **consultar**, sin enviar otra generación. La repetición parcial reutilizando resultados completados queda pendiente.
- Detener bloquea pasos futuros, pero no cancela ni devuelve cargos del proveedor. Las tareas asíncronas ya aceptadas siguen consultándose para recuperar el resultado.

## Persistencia y recuperación

Node **22.13+** requerido (`node:sqlite`; en Node 22 emite una advertencia experimental). En local no requiere Docker:

- `workflows/workflows.sqlite`: documentos transaccionales para workflows, ejecuciones y metadatos de archivos; WAL + synchronous FULL.
- `workflows/assets/`: archivos privados fuera de `public/`, IDs aleatorios, permisos restrictivos.
- Ambos están bajo `OPEN_HIGGSFIELD_STORAGE_DIR` (por defecto la raíz del proyecto), excluidos de Git y Docker context.
- El servidor arranca un motor integrado. Puede cerrarse la pestaña; no debe apagarse el servidor para que siga trabajando.
- Al reiniciar se recuperan tareas con operación remota guardada. Un envío interrumpido sin confirmación se marca para revisión, nunca se reenvía a ciegas.
- Lease de 60 segundos con heartbeat de 15 segundos. Las actualizaciones se protegen por propietario; otro worker no ejecuta una solicitud nueva mientras la lease sigue vigente. Un envío síncrono aceptado justo antes de un fallo puede requerir recuperar su resultado en el proveedor.
- Actualizaciones de grafos con control de revisión: dos pestañas no sobrescriben silenciosamente una a la otra.
- Progreso por consulta autenticada cada 2 segundos, incluyendo reconexión después de recargar; no depende de SSE en memoria.

## EasyPanel

Para una instalación pequeña: imagen Docker normal, **una réplica**, volumen persistente `/app/data`, `OPEN_HIGGSFIELD_APP_ORIGIN=https://tu-dominio`, HTTPS en el proxy. El motor integrado y SQLite funcionan en esa única instancia.

Para separar web/worker:

1. Crea un servicio PostgreSQL privado y configura **WORKFLOWS_DATABASE_URL** en web y worker. Se usa `pg` estándar, no el cliente HTTP de Neon. No sustituyas el `DATABASE_URL` legado con una URL incompatible.
2. Construye la web con el target `runner` (predeterminado) y establece `WORKFLOWS_EXTERNAL_WORKER=1`.
3. Construye el worker con target `workflow-worker`; su comando es `npm run workflows:worker`. Localmente también puede ejecutarse ese comando con la web configurada para no arrancar un segundo motor.
4. Web y worker deben montar **el mismo volumen privado `/app/data`**, con propietario UID/GID 1001: ahí están las conexiones cifradas, su clave maestra y los archivos. PostgreSQL por sí solo no sustituye ese volumen. Esta versión no admite réplicas repartidas sin almacenamiento compartido.
5. No expongas PostgreSQL ni el worker a Internet. Configura reinicio automático. Mantén TLS para conexiones de base de datos que salgan de una red privada; no se deshabilita la validación de certificados en el código.
6. Respalda PostgreSQL y el volumen, incluida `.higgsfield-security`, como un conjunto. Si se usa SQLite, detén el servicio o usa backup de SQLite; no copies solo el `.sqlite` ignorando WAL en actividad.

**No hay migración automática entre SQLite y PostgreSQL.** Cambiar la variable selecciona otro almacén, no traslada el historial. Mantén el backend original o realiza una migración explícita con backup antes de desplegar datos existentes.

El almacenamiento usa documentos en una tabla transaccional y una sección crítica corta; está diseñado para un administrador, no para una granja multiusuario. PostgreSQL protege las actualizaciones mediante advisory locks. Los proveedores se llaman fuera de la transacción.

## Seguridad y verificación

Autenticación y origen verificados en cada endpoint, límites de cuerpo/frecuencia, esquemas estrictos, IDs opacos, rechazo de ciclos y parámetros ajenos al modelo. Sin bloques de código, HTTP arbitrario ni credenciales en el grafo. Los datos públicos de ejecución omiten operaciones internas y capacidades guardadas. Errores de terceros se reducen a códigos cerrados.

Uploads raster decodificados con límite de píxeles, reescritos a PNG conservando transparencia y eliminando metadatos; SVG/HTML rechazados. Videos validados por firma MP4/WebM. Descargas autenticadas, no-store, nosniff y rangos acotados. URLs remotas de resultados usan el descargador existente con defensa SSRF y límites. No se crean enlaces públicos de larga duración para las imágenes de OpenRouter.

`npm run test:security` incluye mocks para generación, polling, fallos, idempotencia, cancelación, aprobación, expiración de lease, persistencia y aislamiento de secretos. Las pruebas no utilizan claves reales ni generan cargos. `npm run lint`, `npm run typecheck` y `npm run build` validan el proyecto. La integración de PostgreSQL/EasyPanel y una generación real de imagen→video requieren verificación en esos entornos; no se deben presentar como probadas solo porque pasan los mocks.

Auditoría del 2026-10-06: `npm audit --omit=dev` no reporta vulnerabilidades. La auditoría completa reporta 5 avisos high en la cadena de desarrollo ESLint/fast-glob/micromatch/braces; no se aplicó `npm audit fix --force` porque propone bajar ESLint Next a una versión incompatible. Revisar esa cadena antes de ampliar herramientas de build a entradas no confiables.
