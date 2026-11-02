# Subsonic schemas

`.tests/subsonic/subsonic-schema.int.test.ts` validates `/rest` responses against both specs:
JSON against OpenSubsonic, XML against classic Subsonic 1.16.1. Before XML validation it removes
only the fields OpenSubsonic adds to each type, so anything neither spec declares still fails.

## `opensubsonic-openapi.json`

A bundled copy of the OpenSubsonic API specification.

- Source: https://github.com/opensubsonic/open-subsonic-api (`openapi/openapi.json`), commit `bed1688`
  (2026-08-03). License: Apache-2.0.
- Refresh: from a checkout of that repository run the same bundle step as its `build:openapi` script,
  writing here:

      pnpm dlx @apidevtools/swagger-cli bundle openapi/openapi.json \
        -o <aurral>/.tests/subsonic/schemas/opensubsonic-openapi.json --type json

## `subsonic-rest-api-1.16.1.xsd`

The classic Subsonic XML schema, unmodified.

- Source: http://www.subsonic.org/pages/inc/api/schema/subsonic-rest-api-1.16.1.xsd
