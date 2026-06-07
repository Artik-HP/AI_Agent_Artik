const assert = require("node:assert/strict");
const test = require("node:test");

const Agent = require("../src/agent");
const memory = require("../src/memory");

test("agent remembers and recalls text", async () => {
  memory.clear();
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
