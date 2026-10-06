# Providers and models

Only the provider selected for a generation needs to be configured. All credentials are read on the server.

## Freepik

```dotenv
FREEPIK_API_KEY=
```

Open-Higgsfield includes Freepik image families such as Flux, Seedream and Z-Image, plus video families such as Kling, Runway, Wan, MiniMax, Seedance, PixVerse, LTX and OmniHuman.

## Google AI Studio

```dotenv
GEMINI_API_KEY=
```

`GOOGLE_AI_API_KEY` is also accepted as a fallback. The integration supports Gemini image generation and Veo video generation.

## Google Vertex AI

```dotenv
GOOGLE_CLOUD_PROJECT=your-project-id
GOOGLE_CLOUD_LOCATION=global
```

Authentication options:

1. Application Default Credentials.
2. A local service account file through `GOOGLE_APPLICATION_CREDENTIALS`.
3. Inline JSON through `GOOGLE_SERVICE_ACCOUNT_JSON` or `GOOGLE_CLOUD_CREDENTIALS`.

Service account files and local credential files are ignored by Git.

## Vercel AI Gateway

```dotenv
AI_GATEWAY_API_KEY=
```

The current catalog includes Google, Black Forest Labs, Recraft, OpenAI, Alibaba Wan and KlingAI models exposed through the gateway.

## OpenRouter

OpenRouter is available as a separate provider with dynamic image and video model discovery:

```dotenv
OPENROUTER_API_KEY=
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_HTTP_REFERER=
OPENROUTER_APP_TITLE=Open-Higgsfield
```

The image API returns base64 assets. The video API is asynchronous and uses the shared task poller.

## Higgsfield API

The Higgsfield API can be connected from the **APIs** panel or through environment variables:

```dotenv
HIGGSFIELD_API_KEY=
HIGGSFIELD_BASE_URL=https://api.higgsfield.ai
```

Higgsfield model paths and model-specific fields are normalized into the same image/video generation flow. Reference uploads still require a public URL provider such as Cloudinary when the selected endpoint cannot access local files.

## API.market

API.market is a marketplace, so each product is configured independently in the **APIs** panel. Add the API key, workspace, slug and media type. The panel can discover generation tools automatically; products with custom tool names or asynchronous status tools can specify `toolName` and `statusToolName` explicitly.

```dotenv
API_MARKET_API_KEY=
API_MARKET_BASE_URL=https://prod.api.market/api/mcp
API_MARKET_WORKSPACE=
API_MARKET_SLUG=
API_MARKET_MEDIA_TYPE=image
API_MARKET_TOOL_NAME=
```

Saved connections are encrypted under `OPEN_HIGGSFIELD_STORAGE_DIR` with an automatically generated master key independent of the administrator password. Use the first-run screen to create the administrator, then the APIs panel to manage connections. EasyPanel requires a persistent `/app/data` volume and `OPEN_HIGGSFIELD_APP_ORIGIN` set to the exact HTTPS origin. See [administration and deployment](admin-setup.md).

## Reference media uploads

Some providers require a public URL for asynchronous image/video inputs. Open-Higgsfield uses Cloudinary for this handoff.

```dotenv
CLOUDINARY_URL=cloudinary://api_key:api_secret@cloud_name
```

You can alternatively configure `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY` and `CLOUDINARY_API_SECRET` separately.

## Adding a model

If an existing provider already supports the model's API shape:

1. Add its capability entry to `src/models/capabilities/image.ts`, `video.ts` or `external.ts`.
2. Set `provider`, `provider_model_id` and `provider_mode` when needed.
3. Define every supported control and media slot.
4. Verify the model appears in `/api/image-models` or `/api/models`.
5. Run `npm run check`.

Freepik models that need a new payload shape also require a model-family adapter in `src/models/adapters/`.

## Adding a provider

Implement the `GenerationProvider` interface from `src/providers/types.ts`, register it in `src/providers/registry.ts`, and add its credential documentation to `.env.example`.
