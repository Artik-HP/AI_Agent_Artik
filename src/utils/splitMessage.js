/**
 * Разбивает длинный текст на части.
 *
 * @param {string} text
 * @param {number} maxLength
 * @returns {string[]}
 */
export function splitMessage(
  text,
  maxLength = 50000
) {
  const chunks = [];

  let current = String(text || "");

  while (current.length > maxLength) {
    let splitIndex =
      current.lastIndexOf("\n", maxLength);

    if (splitIndex < 1) {
      splitIndex = maxLength;
    }

    chunks.push(
      current.slice(0, splitIndex)
    );

    current =
      current.slice(splitIndex);
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}