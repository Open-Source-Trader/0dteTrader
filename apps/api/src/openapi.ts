import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

/**
 * Serves the OpenAPI document as JSON at /openapi.json (root level, outside
 * the /v1 prefix). Paths are derived from the live route table and include
 * the global prefix, so scanners (e.g. Mayhem for API in CI) can discover
 * every route. Swagger UI is not served: its bootstrap relies on inline
 * scripts that helmet's CSP blocks, and the JSON document is the deliverable.
 * DTO body schemas are not included — the project builds with plain tsc, so
 * the Swagger CLI plugin that infers them is unavailable; docs/API-SPEC.md
 * remains the authoritative request/response reference.
 */
export function setupOpenApi(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('0dteTrader API')
    .setDescription(
      'Rapid options trading backend for Webull OpenAPI. Request/response shapes: docs/API-SPEC.md.',
    )
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document, {
    jsonDocumentUrl: 'openapi.json',
    swaggerUiEnabled: false,
  });
}
