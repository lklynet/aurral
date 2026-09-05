# OpenSubsonic OpenAPI snapshot

`opensubsonic-openapi.json` is a bundled copy of the OpenSubsonic API specification, used by
`.tests/subsonic/subsonic-openapi.int.test.js` to validate `/rest` JSON responses.

- Source: https://github.com/opensubsonic/open-subsonic-api (`openapi/openapi.json`), commit `bed1688`
  (2026-08-03). License: Apache-2.0.
- Refresh: from a checkout of that repository run the same bundle step as its `build:openapi` script,
  writing here:

      npx @apidevtools/swagger-cli bundle openapi/openapi.json \
        -o <aurral>/.tests/subsonic/openapi/opensubsonic-openapi.json --type json

The schema only models `f=json` responses; XML is not covered.
