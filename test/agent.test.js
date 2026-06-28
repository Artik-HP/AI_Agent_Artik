import assert from "node:assert/strict";
import test from "node:test";

import Agent from "../src/agent.js";
import * as memory from "../src/memory.js";

delete process.env.DATABASE_URL;
delete process.env.DATABASE_SSL;

test("agent remembers and recalls text", async () => {
  await memory.clear();
  const agent = new Agent();

  assert.equal(
    await agent.process("память"),
    "Пока ничего не помню. Мозг чистый, как новая база данных."
  );
  assert.equal(
    await agent.process("запомни я учу JavaScript"),
    "Запомнил: я учу JavaScript"
  );
  assert.equal(await agent.process("что ты помнишь"), "я учу JavaScript");
});

test("agent calculates simple expressions", async () => {
  const agent = new Agent();

  assert.equal(await agent.process("calc 2 + 2 * 3"), "8");
});

test("agent rejects unsafe calculations", async () => {
  const agent = new Agent();

  assert.equal(
    await agent.process("calc process.exit()"),
    "Можно считать только простые математические выражения."
  );
});

test("agent exposes codebase analyzer tool", async () => {
  const agent = new Agent();

  assert.match(
    await agent.process("/tools"),
    /\/codebase/
  );
});

test("agent exposes image drawing tool", async () => {
  const agent = new Agent();

  assert.match(
    await agent.process("/tools"),
    /\/draw/
  );
});

test("agent creates image generation links", async () => {
  const agent = new Agent();
  const answer = await agent.process("/draw neon cat");

  assert.match(answer, /Картинка готова:/);
  assert.match(answer, /https:\/\/image\.pollinations\.ai\/prompt\/neon%20cat/);
});

test("agent switches back to default mode", async () => {
  const agent = new Agent();

  assert.equal(
    await agent.process("/agent default"),
    "Режим агента переключён: default"
  );
});
