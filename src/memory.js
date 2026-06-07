let memories = [];

function save(text) {
  memories.push(text);
}

function getAll() {
  return [...memories];
}

function clear() {
  memories = [];
}

module.exports = {
  save,
  getAll,
  clear
};
