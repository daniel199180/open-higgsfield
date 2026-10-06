# Consumo y precios

## Interfaz

- **Consumo** en Studio y Workflows muestra USD confirmados, tokens, solicitudes y desglose por conexión/modelo; las últimas 50 solicitudes permiten consultar el coste por generación. Los totales abarcan todos los registros, sin el límite de 50.
- **Precio de generación** debajo del selector de imagen muestra una estimación de salida y abre su desglose. Cambia con el proveedor, modelo y ajustes. No es una garantía de coste total: prompt, referencias y otros cargos pueden sumarse.
- **Configurar tarifa manual** permite registrar USD por imagen para una conexión/modelo/configuración exacta. Se puede retirar para volver a la tarifa automática. Una tarifa manual nunca se convierte en gasto confirmado.
- El detalle por solicitud empieza con esta actualización. No se inventan costes ni tokens históricos. El acumulado de la clave de OpenRouter sí puede incluir generaciones anteriores y consumo en otras aplicaciones; se presenta por separado y nunca se suma al registro local.

## Cobertura y fuentes

OpenRouter: se captura `usage.prompt_tokens`, `completion_tokens`, `total_tokens` y `cost` de las respuestas de imagen/video cuando existen. Los importes se expresan en USD. Los precios de imagen se consultan en `/images/models/{model}/endpoints` (caché de 5 minutos), sin credenciales. Se consideran las tarifas por imagen, tokens y megapíxeles si las dimensiones exactas son conocidas; variantes o unidades no resueltas no se adivinan. Los modelos Gemini documentados usan su tabla de tokens de salida por resolución, verificada el 2026-10-06. El precio unitario siempre procede del endpoint de OpenRouter, no de una tarifa de Google copiada a otra API.

Higgsfield y API.market: sus adaptadores aún no exponen un contrato verificado de USD/tokens por respuesta. Aparecen como no informados; la tarifa manual permite un seguimiento estimado de solicitudes completadas. Llamadas, cuotas, créditos y suscripciones no se convierten a USD ni tokens automáticamente. Lo mismo aplica a proveedores heredados sin instrumentación de uso.

Fuentes:

- [OpenRouter: imágenes, precios por endpoint y usage](https://openrouter.ai/docs/guides/overview/multimodal/image-generation)
- [OpenRouter: acumulado de la clave](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key)
- [Google: tokens de imagen por resolución](https://ai.google.dev/gemini-api/docs/image-generation)
- [Google: Nano Banana Pro y tokens por imagen](https://ai.google.dev/gemini-api/docs/pricing)
- [API.market: unidades y cuotas de uso](https://docs.api.market/api.market-usage-api-documentation)

## Persistencia y seguridad

El registro contable es independiente de la galería. SQLite: `OPEN_HIGGSFIELD_STORAGE_DIR/billing/usage.sqlite` (directorio del proyecto si no se configura almacenamiento). En Easypanel, mantener el volumen persistente `/app/data`; incluirlo en copias de seguridad, con WAL consistente o el servicio detenido. Si se configura `WORKFLOWS_DATABASE_URL`, web y worker utilizan las tablas `generation_usage` y `generation_rates` en PostgreSQL. Cambiar de backend no migra registros previos automáticamente. Un despliegue Vercel sin base persistente se rechaza.

Las intenciones se guardan antes de enviar solicitudes facturables. Las respuestas actualizan una fila por tarea Studio o por ejecución/bloque Workflow; el polling reemplaza las cifras acumuladas, no las suma. Se guarda el uso antes de descargar los archivos. Una interrupción permanece sin confirmar: no implica cargo cero. Los importes estimados solo se agregan para solicitudes completadas sin cargo informado y nunca se mezclan con USD confirmados.

No se guardan claves, prompts ni respuestas crudas del proveedor en este registro. Los endpoints requieren sesión de administrador; cambiar tarifas también exige origen autorizado, JSON limitado, validación y rate limiting. El acumulado de OpenRouter se obtiene solo desde el servidor contra una URL oficial fija, sin redirects, y se devuelve una lista blanca de campos. Reutilizar la misma API key en varias conexiones puede mostrar acumulados externos duplicados; no se totalizan entre conexiones.

Validación: `npm run test:security`, `npm run typecheck`, `npm run lint`, `OPEN_HIGGSFIELD_BUILD_DIR=.next-validation npm run build`. Los tests usan proveedores simulados y almacenamiento temporal; no consumen créditos reales. La variante PostgreSQL requiere validación de despliegue si no hay un servidor disponible localmente.
