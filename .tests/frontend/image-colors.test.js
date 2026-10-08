import assert from "node:assert/strict";
import test from "node:test";
import { startFrontendServer } from "../helpers/frontendServer.js";

test("external artwork gradients do not request images in CORS mode", async (t) => {
  const vite = await startFrontendServer();
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

test("album-art accents read external covers in CORS mode", async (t) => {
  const vite = await startFrontendServer();
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
        getImageData(_x, _y, width, height) {
          if (loadedImage.crossOrigin !== "anonymous") throw new Error("Canvas is tainted");
          const data = new Uint8ClampedArray(width * height * 4);
          for (let index = 0; index < data.length; index += 4) data.set([200, 40, 40, 255], index);
          return { data };
        },
      }),
    }),
  };
  t.after(async () => {
    globalThis.document = previousDocument;
    globalThis.Image = previousImage;
    await vite.close();
  });

  const { extractArtworkAccent } = await vite.ssrLoadModule("/src/utils/imageColors.js?accent-cors-test");
  const color = await extractArtworkAccent("https://assets.fanart.tv/fanart/cover.jpg");

  assert.match(color, /^#[\da-f]{6}$/);
  assert.ok(Number.parseInt(color.slice(1, 3), 16) > Number.parseInt(color.slice(5, 7), 16), `${color} is red`);
});
