import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

test("external artwork gradients do not request images in CORS mode", async (t) => {
  const vite = await createServer({
    root: "frontend",
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true },
  });
  const previousDocument = globalThis.document;
  const previousImage = globalThis.Image;
  let loadedImage;

  globalThis.Image = class {
    set src(value) {
      this.currentSrc = value;
      loadedImage = this;
      queueMicrotask(() => this.onload?.());
    }
  };
  globalThis.document = {
    createElement: () => ({
      getContext: () => ({
        drawImage() {},
        getImageData() {
          throw new Error("Canvas is tainted");
        },
      }),
    }),
  };
  t.after(async () => {
    globalThis.document = previousDocument;
    globalThis.Image = previousImage;
    await vite.close();
  });

  const { extractTwoToneGradientFromImage } = await vite.ssrLoadModule(
    "/src/utils/imageColors.js?external-cors-test",
  );
  const source = "https://imagecache.lidarr.audio/v1/caa/release/image.jpg";
  const result = await extractTwoToneGradientFromImage(source);

  assert.equal(loadedImage.currentSrc, source);
  assert.notEqual(loadedImage.crossOrigin, "anonymous");
  assert.deepEqual(result, { top: "#343434", bottom: "#171717" });
});
