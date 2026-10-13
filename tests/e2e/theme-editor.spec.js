import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

test("the theme editor blocks invalid colors and exports themes that import again", async ({ page }) => {
  await page.goto("/profile");
  await page.getByRole("button", { name: "Create theme" }).click();
  const editor = page.getByRole("dialog", { name: "Create theme" });
  const save = editor.getByRole("button", { name: "Save theme" });
  const background = editor.getByRole("textbox", { name: "Background", exact: true });
  const original = await background.inputValue();

  await background.fill("#zzzzzz");
  await expect(save).toBeDisabled();
  await expect(editor.getByRole("alert")).toBeVisible();
  await background.fill(original);
  await expect(save).toBeEnabled();

  await editor.getByRole("textbox", { name: "Name" }).fill("E2E export theme");
  await save.click();
  await expect(editor).toBeHidden();

  await page.getByRole("button", { name: "Edit E2E export theme" }).click();
  const edit = page.getByRole("dialog", { name: "Edit theme" });
  await edit.getByRole("textbox", { name: "Name" }).fill("");
  const downloadPromise = page.waitForEvent("download");
  await edit.getByRole("button", { name: "Export" }).click();
  const exported = await readFile(await (await downloadPromise).path(), "utf8");
  await edit.getByRole("button", { name: "Cancel" }).click();

  await page.getByRole("button", { name: "Import" }).click();
  const importer = page.getByRole("dialog", { name: "Import theme" });
  await importer.getByRole("textbox", { name: "Theme" }).fill(exported);
  await importer.getByRole("button", { name: "Continue" }).click();
  const review = page.getByRole("dialog", { name: "Review imported theme" });
  await expect(review).toBeVisible();
  await review.getByRole("button", { name: "Cancel" }).click();

  await page.getByRole("button", { name: "Edit E2E export theme" }).click();
  await page.getByRole("dialog", { name: "Edit theme" }).getByRole("button", { name: "Remove theme" }).click();
  await expect(page.getByRole("button", { name: "Edit E2E export theme" })).toHaveCount(0);
});
