import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import Agent from "../src/agent.js";

test("image generation preserves chat files and router state without network", async t => {
  const root = process.cwd();
  const dir = fs.mkdtempSync(path.join(root, "test", ".tmp-image-review-"));
  const savedEnv = Object.fromEntries(
    ["OPENROUTER_API_KEY", "MODEL_DEFAULT", "DATABASE_URL"].map(key => [key, process.env[key]])
  );
  t.after(() => {
    process.chdir(root);
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    assert.ok(fs.realpathSync(dir).startsWith(path.join(root, "test") + path.sep));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  process.chdir(dir);
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.MODEL_DEFAULT = "test-model";
  delete process.env.DATABASE_URL;
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-23T00:00:00Z") });
  const imageRequests = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const body = JSON.parse(options.body);
    let message;
    if (body.modalities) {
      imageRequests.push(body);
      message = { images: [{ image_url: {
        url: `data:image/png;base64,${Buffer.from(`image-${imageRequests.length}`).toString("base64")}`
      } }] };
    } else if (body.messages[0].content.includes("роутер инструментов")) {
      // Даже ошибочный выбор роутера не должен обходить явный запрет рисовать.
      message = { content: JSON.stringify({ tool: "draw", input: "дракон" }) };
    } else {
      message = { content: "Это объяснение команды." };
    }
    return { ok: true, json: async () => ({ choices: [{ message }] }) };
  });

  const first = new Agent("first");
  const second = new Agent("second");
  await Promise.all([first.process("/draw кот"), second.process("/draw дракон")]);
  assert.notEqual(first.lastImagePath, second.lastImagePath);
  assert.equal(fs.readFileSync(first.lastImagePath, "utf8"), "image-1");
  assert.equal(fs.readFileSync(second.lastImagePath, "utf8"), "image-2");

  const routed = new Agent("routed");
  await routed.process("хочу картинку дракона в стиле киберпанк");
  const source = routed.lastImagePath;
  assert.ok(source);
  const sourceBytes = fs.readFileSync(source).toString("base64");
  assert.match(await routed.process("/editimage добавь снег"), /Картинка-файл/);
  assert.equal(imageRequests.at(-1).messages[0].content[1].image_url.url, `data:image/png;base64,${sourceBytes}`);
  assert.notEqual(routed.lastImagePath, source);
  assert.equal(fs.readFileSync(source).toString("base64"), sourceBytes);

  const count = imageRequests.length;
  for (const query of [
    "Не рисуй ничего: объясни, что значит команда «нарисуй кота»",
    "Объясни команду «нарисуй кота»",
    "Не нарисуй кота",
    "Что означает команда draw?"
  ]) {
    assert.equal(await new Agent("discussion").process(query), "Это объяснение команды.");
  }
  assert.equal(imageRequests.length, count);
  for (const query of ["нарисуй кота", "слушай, нарисуй дракона", "пожалуйста, создай картинку озера"]) {
    assert.match(await first.process(query), /Картинка-файл/);
  }
  assert.equal(imageRequests.length, count + 3);
});
